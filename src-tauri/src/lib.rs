use serde::Serialize;
use std::process::Command;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Serialize)]
pub struct NodeOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
}

pub fn execute_script(script: &str) -> NodeOutput {
    if script.trim().is_empty() {
        return NodeOutput {
            stdout: String::new(),
            stderr: String::new(),
            code: Some(0),
        };
    }

    let mut cmd = Command::new("powershell.exe");
    cmd.args([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
    ]);

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    match cmd.output() {
        Ok(output) => NodeOutput {
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            code: output.status.code(),
        },
        Err(e) => NodeOutput {
            stdout: String::new(),
            stderr: e.to_string(),
            code: Some(-1),
        },
    }
}

#[tauri::command]
fn run_node(script: String) -> Result<NodeOutput, String> {
    Ok(execute_script(&script))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![run_node])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
