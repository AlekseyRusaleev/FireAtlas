use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InfocardSession {
    pub access_token: String,
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfocardFileHit {
    pub id: String,
    pub name: String,
    pub status: Option<String>,
}

fn session_path(app_data: &PathBuf) -> PathBuf {
    app_data.join("infocard_session.json")
}

fn load_session(path: &PathBuf) -> InfocardSession {
    if !path.exists() {
        return InfocardSession::default();
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_session(path: &PathBuf, session: &InfocardSession) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, serde_json::to_string_pretty(session).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

fn api_base(state: &AppState) -> String {
    let s = state.settings.lock();
    s.infocard_api_base.trim_end_matches('/').to_string()
}

#[tauri::command]
pub fn infocard_get_session(state: State<'_, AppState>, app: tauri::AppHandle) -> Result<InfocardSession, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let _ = state;
    Ok(load_session(&session_path(&dir)))
}

#[tauri::command]
pub fn infocard_logout(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let path = session_path(&dir);
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn infocard_login(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    login: String,
    password: String,
) -> Result<InfocardSession, String> {
    let base = api_base(&state);
    let url = format!("{base}/auth/login");
    let body = serde_json::json!({ "login": login, "password": password });

    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .send_json(body)
        .map_err(|e| e.to_string())?;

    #[derive(Deserialize)]
    struct LoginResp {
        #[serde(rename = "accessToken")]
        access_token: String,
    }

    let parsed: LoginResp = resp.into_json().map_err(|e| e.to_string())?;
    let session = InfocardSession {
        access_token: parsed.access_token,
        login: login.clone(),
    };

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    save_session(&session_path(&dir), &session)?;

    // Persist login hint in settings
    {
        let mut s = state.settings.lock();
        s.infocard_login = login;
        s.infocard_enabled = true;
        state.store.save(&s)?;
    }

    Ok(session)
}

#[tauri::command]
pub fn infocard_search_files(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<InfocardFileHit>, String> {
    let base = api_base(&state);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let session = load_session(&session_path(&dir));
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let lim = limit.unwrap_or(50);
    let url = format!("{base}/search/files?q={}&limit={}", urlencoding_lite(&query), lim);

    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", session.access_token))
        .call()
        .map_err(|e| e.to_string())?;

    let value: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
    let items = value
        .get("items")
        .or_else(|| value.get("files"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in items {
        let id = item
            .get("id")
            .or_else(|| item.get("_id"))
            .map(|v| v.as_str().unwrap_or(&v.to_string()).to_string())
            .unwrap_or_default();
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if !id.is_empty() {
            out.push(InfocardFileHit { id, name, status });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn infocard_open_pdf(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    file_id: String,
) -> Result<String, String> {
    let base = api_base(&state);
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let session = load_session(&session_path(&dir));
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let cache = dir.join("infocard_pdf_cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let dest = cache.join(format!("{file_id}.pdf"));

    let url = format!("{base}/files/{file_id}/pdf");
    let resp = ureq::get(&url)
        .set("Authorization", &format!("Bearer {}", session.access_token))
        .call()
        .map_err(|e| e.to_string())?;

    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;

    open::that(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

fn urlencoding_lite(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
