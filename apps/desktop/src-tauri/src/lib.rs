use keyring::Entry;
use serde::Serialize;
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeConfig {
    runtime_url: String,
    token: String,
}

struct RuntimeProcess(Mutex<Option<Child>>);

#[tauri::command]
fn start_runtime(state: State<'_, RuntimeProcess>) -> Result<RuntimeConfig, String> {
    let runtime_url = std::env::var("LOOM_RUNTIME_URL").unwrap_or_else(|_| "http://127.0.0.1:3210".to_string());
    let port_in_use = std::net::TcpStream::connect_timeout(
        &"127.0.0.1:3210".parse().map_err(|error: std::net::AddrParseError| error.to_string())?,
        Duration::from_millis(250),
    ).is_ok();
    if cfg!(debug_assertions) && port_in_use {
        return Ok(RuntimeConfig { runtime_url, token: "loom-development".to_string() });
    }
    if port_in_use {
        return Err("端口 3210 已被其他进程占用，Loom 不会连接身份不明的本地服务。".to_string());
    }

    let token = uuid::Uuid::new_v4().simple().to_string();
    let root = std::env::var("LOOM_ROOT").unwrap_or_else(|_| "E:\\Loom".to_string());
    let entry = format!("{}\\source\\packages\\runtime\\dist\\server.mjs", root);
    if !std::path::Path::new(&entry).is_file() {
        return Err(format!("Runtime 尚未构建：{}", entry));
    }
    let child = Command::new("node")
        .arg(entry)
        .env("LOOM_ROOT", &root)
        .env("LOOM_RUNTIME_TOKEN", &token)
        .env("NODE_ENV", "production")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x08000000)
        .spawn()
        .map_err(|error| format!("无法启动 Runtime：{}", error))?;
    *state.0.lock().map_err(|_| "Runtime 状态锁失败".to_string())? = Some(child);
    for _ in 0..30 {
        std::thread::sleep(Duration::from_millis(100));
        if std::net::TcpStream::connect("127.0.0.1:3210").is_ok() {
            return Ok(RuntimeConfig { runtime_url, token });
        }
    }
    Err("Runtime 启动超时".to_string())
}

#[tauri::command]
fn store_credential(account: String, secret: String) -> Result<(), String> {
    Entry::new("app.loom.desktop", &account)
        .map_err(|error| error.to_string())?
        .set_password(&secret)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn credential_status(account: String) -> Result<bool, String> {
    let entry = Entry::new("app.loom.desktop", &account).map_err(|error| error.to_string())?;
    match entry.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn read_credential(account: String) -> Result<String, String> {
    Entry::new("app.loom.desktop", &account)
        .map_err(|error| error.to_string())?
        .get_password()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_credential(account: String) -> Result<(), String> {
    Entry::new("app.loom.desktop", &account)
        .map_err(|error| error.to_string())?
        .delete_credential()
        .map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RuntimeProcess(Mutex::new(None)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![start_runtime, store_credential, read_credential, credential_status, delete_credential])
        .run(tauri::generate_context!())
        .expect("error while running Loom");
}
