use serde::Serialize;
use std::io::{BufRead, BufReader, Write};
use std::mem;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const RUN_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Serialize)]
pub struct NodeOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

fn spawn_powershell() -> std::io::Result<Child> {
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"]);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    cmd.spawn()
}

struct ShellSession {
    child: Child,
    stdin: ChildStdin,
    stdout_rx: Receiver<String>,
    stderr_buf: Arc<Mutex<Vec<String>>>,
    marker_seq: AtomicU64,
}

impl ShellSession {
    fn spawn() -> std::io::Result<Self> {
        let mut child = spawn_powershell()?;
        let stdin = child.stdin.take().expect("stdin powinien być piped");
        let stdout = child.stdout.take().expect("stdout powinien być piped");
        let stderr = child.stderr.take().expect("stderr powinien być piped");

        let (tx, rx) = mpsc::channel::<String>();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        let stderr_buf = Arc::new(Mutex::new(Vec::new()));
        let stderr_buf_writer = Arc::clone(&stderr_buf);
        std::thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                match line {
                    Ok(l) => {
                        if let Ok(mut buf) = stderr_buf_writer.lock() {
                            buf.push(l);
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(ShellSession {
            child,
            stdin,
            stdout_rx: rx,
            stderr_buf,
            marker_seq: AtomicU64::new(0),
        })
    }

    fn is_alive(&mut self) -> bool {
        matches!(self.child.try_wait(), Ok(None))
    }

    fn run(&mut self, script: &str) -> NodeOutput {
        if script.trim().is_empty() {
            return NodeOutput {
                stdout: String::new(),
                stderr: String::new(),
                code: Some(0),
            };
        }

        let n = self.marker_seq.fetch_add(1, Ordering::SeqCst);
        let marker = format!("__SHELLCRAFT_MARK_{n}__");

        let write_result = (|| -> std::io::Result<()> {
            writeln!(self.stdin, "{script}")?;
            writeln!(self.stdin, "$__shellcraft_ok = $?")?;
            writeln!(self.stdin, "Write-Output \"{marker}:$__shellcraft_ok\"")?;
            self.stdin.flush()
        })();

        if let Err(e) = write_result {
            return NodeOutput {
                stdout: String::new(),
                stderr: format!("Nie udało się wysłać skryptu do sesji: {e}"),
                code: Some(-1),
            };
        }

        let mut stdout_lines = Vec::new();
        let deadline = std::time::Instant::now() + RUN_TIMEOUT;
        let mut ok = true;
        let mut timed_out = true;

        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match self.stdout_rx.recv_timeout(remaining) {
                Ok(line) => {
                    if let Some(rest) = line.strip_prefix(&marker) {
                        ok = rest.trim_start_matches(':').trim() != "False";
                        timed_out = false;
                        break;
                    }
                    stdout_lines.push(line);
                }
                Err(_) => break,
            }
        }

        let stderr_lines = self
            .stderr_buf
            .lock()
            .map(|mut buf| mem::take(&mut *buf))
            .unwrap_or_default();

        if timed_out {
            return NodeOutput {
                stdout: stdout_lines.join("\n"),
                stderr: format!(
                    "Przekroczono limit czasu ({}s) — sesja może być zawieszona. Użyj \"Nowa sesja\", żeby ją zresetować.",
                    RUN_TIMEOUT.as_secs()
                ),
                code: Some(-1),
            };
        }

        NodeOutput {
            stdout: stdout_lines.join("\n"),
            stderr: stderr_lines.join("\n"),
            code: Some(if ok { 0 } else { 1 }),
        }
    }
}

impl Drop for ShellSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub struct SessionManager {
    session: Mutex<Option<ShellSession>>,
    current_pid: Mutex<Option<u32>>,
}

impl SessionManager {
    pub fn new() -> Self {
        SessionManager {
            session: Mutex::new(None),
            current_pid: Mutex::new(None),
        }
    }

    pub fn run(&self, script: &str) -> NodeOutput {
        let mut guard = match self.session.lock() {
            Ok(g) => g,
            Err(e) => e.into_inner(),
        };

        let needs_spawn = match guard.as_mut() {
            Some(session) => !session.is_alive(),
            None => true,
        };

        if needs_spawn {
            match ShellSession::spawn() {
                Ok(session) => {
                    if let Ok(mut pid) = self.current_pid.lock() {
                        *pid = Some(session.child.id());
                    }
                    *guard = Some(session);
                }
                Err(e) => {
                    return NodeOutput {
                        stdout: String::new(),
                        stderr: format!("Nie udało się uruchomić sesji PowerShell: {e}"),
                        code: Some(-1),
                    };
                }
            }
        }

        guard.as_mut().expect("sesja właśnie utworzona").run(script)
    }

    pub fn restart(&self) {
        let pid = self.current_pid.lock().ok().and_then(|p| *p);
        if let Some(pid) = pid {
            #[cfg(target_os = "windows")]
            {
                let mut kill = Command::new("taskkill.exe");
                kill.args(["/PID", &pid.to_string(), "/T", "/F"]);
                #[cfg(target_os = "windows")]
                kill.creation_flags(CREATE_NO_WINDOW);
                let _ = kill.output();
            }
            #[cfg(not(target_os = "windows"))]
            {
                let _ = Command::new("kill").args(["-9", &pid.to_string()]).output();
            }
        }
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
fn run_node(state: tauri::State<SessionManager>, script: String) -> Result<NodeOutput, String> {
    Ok(state.run(&script))
}

#[tauri::command]
fn restart_session(state: tauri::State<SessionManager>) -> Result<(), String> {
    state.restart();
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(SessionManager::new())
        .invoke_handler(tauri::generate_handler![run_node, restart_session])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
