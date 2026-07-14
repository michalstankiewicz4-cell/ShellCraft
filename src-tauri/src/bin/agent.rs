use serde::Deserialize;
use shellcraft_lib::SessionManager;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use tiny_http::{Header, Method, Request, Response, Server};

const PORT: u16 = 47932;
const ALLOWED_ORIGINS: [&str; 3] = [
    "https://michalstankiewicz4-cell.github.io",
    "http://localhost:1420",
    "http://127.0.0.1:1420",
];

#[derive(Deserialize)]
struct RunRequest {
    script: String,
}

fn token_file() -> PathBuf {
    let mut dir = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    dir.push("ShellCraft");
    dir.join("agent_token.txt")
}

fn load_or_create_token() -> String {
    let path = token_file();
    if let Ok(existing) = fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("brak dostępu do generatora losowego systemu");
    let token: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();

    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(&path, &token);
    token
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("nagłówek HTTP")
}

fn with_cors<R: Read>(mut resp: Response<R>, origin: &str) -> Response<R> {
    resp.add_header(header("Access-Control-Allow-Origin", origin));
    resp.add_header(header("Access-Control-Allow-Methods", "GET, POST, OPTIONS"));
    resp.add_header(header(
        "Access-Control-Allow-Headers",
        "Content-Type, X-ShellCraft-Token",
    ));
    resp.add_header(header("Access-Control-Allow-Private-Network", "true"));
    resp.add_header(header("Access-Control-Max-Age", "600"));
    resp
}

fn get_header(request: &Request, name: &str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str().to_string())
}

fn has_valid_token(request: &Request, token: &str) -> bool {
    get_header(request, "X-ShellCraft-Token")
        .map(|v| v == token)
        .unwrap_or(false)
}

fn handle(mut request: Request, token: &str, manager: &SessionManager) {
    let origin = get_header(&request, "Origin").unwrap_or_default();
    let origin_ok = ALLOWED_ORIGINS.contains(&origin.as_str());
    let method = request.method().clone();

    if method == Method::Options {
        let status = if origin_ok { 204 } else { 403 };
        let resp = Response::empty(status);
        let resp = if origin_ok { with_cors(resp, &origin) } else { resp };
        let _ = request.respond(resp);
        return;
    }

    if !origin_ok {
        let _ = request.respond(Response::empty(403));
        return;
    }

    match (method, request.url()) {
        (Method::Get, "/health") => {
            if !has_valid_token(&request, token) {
                let _ = request.respond(with_cors(Response::empty(401), &origin));
                return;
            }
            let _ = request.respond(with_cors(Response::from_string("ok"), &origin));
        }
        (Method::Post, "/run") => {
            if !has_valid_token(&request, token) {
                let _ = request.respond(with_cors(Response::empty(401), &origin));
                return;
            }

            let mut body = String::new();
            if request.as_reader().read_to_string(&mut body).is_err() {
                let _ = request.respond(with_cors(Response::empty(400), &origin));
                return;
            }

            let payload: RunRequest = match serde_json::from_str(&body) {
                Ok(p) => p,
                Err(_) => {
                    let _ = request.respond(with_cors(Response::empty(400), &origin));
                    return;
                }
            };

            let output = manager.run(&payload.script);
            let json = serde_json::to_string(&output).unwrap_or_else(|_| "{}".to_string());
            let resp = Response::from_string(json)
                .with_header(header("Content-Type", "application/json"));
            let _ = request.respond(with_cors(resp, &origin));
        }
        (Method::Post, "/restart") => {
            if !has_valid_token(&request, token) {
                let _ = request.respond(with_cors(Response::empty(401), &origin));
                return;
            }
            manager.restart();
            let _ = request.respond(with_cors(Response::from_string("ok"), &origin));
        }
        _ => {
            let _ = request.respond(with_cors(Response::empty(404), &origin));
        }
    }
}

fn main() {
    let token = Arc::new(load_or_create_token());
    let manager = Arc::new(SessionManager::new());
    let addr = format!("127.0.0.1:{PORT}");
    let server = Server::http(&addr).expect("nie udało się uruchomić agenta na porcie");

    println!("ShellCraft Agent nasłuchuje na http://{addr}");
    println!("Token: {}", token);
    println!("Wklej ten token w panelu \"Połącz z agentem\" na stronie ShellCraft, żeby połączyć przeglądarkę z tym komputerem.");

    for request in server.incoming_requests() {
        let token = Arc::clone(&token);
        let manager = Arc::clone(&manager);
        thread::spawn(move || handle(request, &token, &manager));
    }
}
