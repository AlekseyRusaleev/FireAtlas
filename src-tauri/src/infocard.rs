use crate::AppState;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct InfocardSession {
    pub access_token: String,
    #[serde(default)]
    pub refresh_token: String,
    pub login: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfocardFileHit {
    pub id: String,
    pub name: String,
    pub status: Option<String>,
    pub kind: Option<String>,
}

fn session_path(app_data: &PathBuf) -> PathBuf {
    app_data.join("infocard_session.json")
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|e| e.to_string())
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
    fs::write(
        path,
        serde_json::to_string_pretty(session).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn api_base(state: &AppState) -> String {
    let s = state.settings.lock();
    let base = s.infocard_api_base.trim();
    if base.is_empty() {
        "https://infocardmchs.ru/api".into()
    } else {
        base.trim_end_matches('/').to_string()
    }
}

fn auth_header(token: &str) -> String {
    format!("Bearer {token}")
}

/// Refresh access token for desktop (no httpOnly cookies — use body refreshToken).
fn refresh_access(
    base: &str,
    session: &mut InfocardSession,
    session_file: &PathBuf,
) -> Result<(), String> {
    if session.refresh_token.is_empty() {
        return Err("Сессия Infocard истекла — войдите снова".into());
    }
    let url = format!("{base}/auth/refresh");
    let body = serde_json::json!({ "refreshToken": session.refresh_token });
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("X-Client", "mobile")
        .send_json(body)
        .map_err(|e| format!("Infocard refresh: {e}"))?;

    #[derive(Deserialize)]
    struct RefreshResp {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: Option<String>,
    }

    let parsed: RefreshResp = resp
        .into_json()
        .map_err(|e| format!("Infocard refresh JSON: {e}"))?;
    session.access_token = parsed.access_token;
    if let Some(rt) = parsed.refresh_token {
        if !rt.is_empty() {
            session.refresh_token = rt;
        }
    }
    save_session(session_file, session)
}

fn authorized_get(
    base: &str,
    path_and_query: &str,
    session: &mut InfocardSession,
    session_file: &PathBuf,
) -> Result<ureq::Response, String> {
    let url = format!("{base}{path_and_query}");
    let first = ureq::get(&url)
        .set("Authorization", &auth_header(&session.access_token))
        .set("X-Client", "mobile")
        .call();

    match first {
        Ok(resp) => Ok(resp),
        Err(ureq::Error::Status(401, _)) | Err(ureq::Error::Status(403, _)) => {
            refresh_access(base, session, session_file)?;
            ureq::get(&url)
                .set("Authorization", &auth_header(&session.access_token))
                .set("X-Client", "mobile")
                .call()
                .map_err(|e| format!("Infocard API: {e}"))
        }
        Err(e) => Err(format!("Infocard API: {e}")),
    }
}

#[tauri::command]
pub fn infocard_get_session(
    _state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<InfocardSession, String> {
    let dir = app_data_dir(&app)?;
    Ok(load_session(&session_path(&dir)))
}

#[tauri::command]
pub fn infocard_logout(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let dir = app_data_dir(&app)?;
    let path = session_path(&dir);
    let session = load_session(&path);

    // Best-effort server logout; ignore network errors.
    if !session.access_token.is_empty() {
        let base = api_base(&state);
        let url = format!("{base}/auth/logout");
        let body = if session.refresh_token.is_empty() {
            serde_json::json!({})
        } else {
            serde_json::json!({ "refreshToken": session.refresh_token })
        };
        let _ = ureq::post(&url)
            .set("Authorization", &auth_header(&session.access_token))
            .set("Content-Type", "application/json")
            .set("X-Client", "mobile")
            .send_json(body);
    }

    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn infocard_login(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    login: String,
    password: String,
) -> Result<InfocardSession, String> {
    let base = api_base(&state);
    let url = format!("{base}/auth/login");
    let body = serde_json::json!({ "login": login, "password": password });

    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("X-Client", "mobile")
        .send_json(body)
        .map_err(|e| format!("Infocard login: {e}"))?;

    #[derive(Deserialize)]
    struct LoginResp {
        #[serde(rename = "accessToken")]
        access_token: String,
        #[serde(rename = "refreshToken")]
        refresh_token: Option<String>,
    }

    let parsed: LoginResp = resp
        .into_json()
        .map_err(|e| format!("Infocard login JSON: {e}"))?;
    let session = InfocardSession {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_default(),
        login: login.clone(),
    };

    let dir = app_data_dir(&app)?;
    save_session(&session_path(&dir), &session)?;

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
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<InfocardFileHit>, String> {
    let base = api_base(&state);
    let dir = app_data_dir(&app)?;
    let session_file = session_path(&dir);
    let mut session = load_session(&session_file);
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let lim = limit.unwrap_or(50);
    let path = format!(
        "/search/files?q={}&limit={}",
        urlencoding_lite(&query),
        lim
    );
    let resp = authorized_get(&base, &path, &mut session, &session_file)?;

    let value: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("Infocard search JSON: {e}"))?;
    let items = value
        .get("items")
        .or_else(|| value.get("files"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for item in items {
        let kind = item
            .get("type")
            .or_else(|| item.get("kind"))
            .and_then(|v| v.as_str())
            .unwrap_or("file")
            .to_string();
        // Поиск API отдаёт и папки — для открытия PDF они не нужны.
        if kind == "folder" {
            continue;
        }
        let id = item
            .get("id")
            .or_else(|| item.get("_id"))
            .map(|v| {
                if let Some(s) = v.as_str() {
                    s.to_string()
                } else {
                    v.to_string().trim_matches('"').to_string()
                }
            })
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
            out.push(InfocardFileHit {
                id,
                name,
                status,
                kind: Some(kind),
            });
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn infocard_open_pdf(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    file_id: String,
) -> Result<String, String> {
    let base = api_base(&state);
    let dir = app_data_dir(&app)?;
    let session_file = session_path(&dir);
    let mut session = load_session(&session_file);
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let cache = dir.join("infocard_pdf_cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let safe_id = file_id.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let dest = cache.join(format!("{safe_id}.pdf"));

    let path = format!("/files/{}/pdf", urlencoding_lite(&file_id));
    let resp = authorized_get(&base, &path, &mut session, &session_file)?;

    let mut reader = resp.into_reader();
    let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;
    std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;

    open::that(&dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfocardMapMarker {
    pub id: i64,
    pub name: String,
    pub comment: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub created_at: String,
    pub server_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfocardMarkersState {
    pub markers: Vec<InfocardMapMarker>,
    pub file: Option<serde_json::Value>,
    pub file_error: Option<String>,
}

fn hash_marker_id(s: &str) -> i64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    let v = h as i64;
    // keep negative to avoid clashing with local sqlite ids
    if v == 0 {
        -1
    } else if v > 0 {
        -v
    } else {
        v
    }
}

#[tauri::command]
pub fn infocard_list_markers(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<InfocardMarkersState, String> {
    let base = api_base(&state);
    let dir = app_data_dir(&app)?;
    let session_file = session_path(&dir);
    let mut session = load_session(&session_file);
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let resp = authorized_get(&base, "/markers", &mut session, &session_file)?;
    let value: serde_json::Value = resp
        .into_json()
        .map_err(|e| format!("Infocard markers JSON: {e}"))?;
    let items = value
        .get("items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut markers = Vec::new();
    for item in items {
        let server_id = item
            .get("id")
            .or_else(|| item.get("_id"))
            .map(|v| {
                v.as_str()
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| v.to_string().trim_matches('"').to_string())
            })
            .unwrap_or_default();
        if server_id.is_empty() {
            continue;
        }
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Объект")
            .to_string();
        let mut comment = item
            .get("description")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        if let Some(wt) = item
            .get("waterType")
            .or_else(|| item.get("water_type"))
            .or_else(|| item.get("type"))
            .and_then(|v| v.as_str())
        {
            let tag = wt.trim();
            if !tag.is_empty() && tag != "marker" && tag != "file" {
                comment = Some(match comment {
                    Some(c) => format!("{tag}\n{c}"),
                    None => tag.to_string(),
                });
            }
        }
        let lat = item.get("lat").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let lon = item.get("lon").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let created_at = item
            .get("createdAt")
            .or_else(|| item.get("created_at"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        markers.push(InfocardMapMarker {
            id: hash_marker_id(&server_id),
            name,
            comment,
            lat,
            lon,
            created_at,
            server_id,
        });
    }

    Ok(InfocardMarkersState {
        markers,
        file: None,
        file_error: None,
    })
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
