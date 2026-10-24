//! Full Infocard offline package: folder tree + pinned PDFs + markers.

use crate::infocard::{
    authorized_get, load_session, save_session, session_path, urlencoding_lite, InfocardSession,
};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub const ROOTS_CACHE_ID: &str = "__roots__";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineSyncMeta {
    pub saved_at: String,
    pub file_count: u32,
    pub bytes_total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineProgress {
    pub running: bool,
    pub phase: String,
    pub done: u32,
    pub total: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderCache {
    folder_id: String,
    folders: Vec<serde_json::Value>,
    files: Vec<serde_json::Value>,
    saved_at: String,
    pinned: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OfflineSearchHit {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

fn offline_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("infocard_offline");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn pdf_dir(root: &Path) -> PathBuf {
    root.join("pdfs")
}

fn folder_path(root: &Path, folder_id: &str) -> PathBuf {
    root.join(format!("folder_{folder_id}.json"))
}

fn meta_path(root: &Path) -> PathBuf {
    root.join("sync_meta.json")
}

fn manifest_path(root: &Path) -> PathBuf {
    root.join("manifest.json")
}

fn markers_path(root: &Path) -> PathBuf {
    root.join("markers.json")
}

pub fn get_sync_meta(app: &AppHandle) -> Result<Option<OfflineSyncMeta>, String> {
    let root = offline_root(app)?;
    let path = meta_path(&root);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string()).map(Some)
}

fn write_folder_cache(root: &Path, entry: &FolderCache) -> Result<(), String> {
    fs::write(
        folder_path(root, &entry.folder_id),
        serde_json::to_string_pretty(entry).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())
}

fn read_folder_cache(root: &Path, folder_id: &str) -> Result<Option<FolderCache>, String> {
    let path = folder_path(root, folder_id);
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string()).map(Some)
}

fn pdf_marker_path(root: &Path, file_id: &str) -> PathBuf {
    pdf_dir(root).join(format!("{file_id}.marker"))
}

pub fn cached_pdf_path(app: &AppHandle, file_id: &str) -> Result<Option<PathBuf>, String> {
    let root = offline_root(app)?;
    let pdf = pdf_dir(&root).join(format!("{file_id}.pdf"));
    if pdf.is_file() {
        return Ok(Some(pdf));
    }
    Ok(None)
}

fn value_id(v: &serde_json::Value) -> Option<String> {
    v.get("id")
        .or_else(|| v.get("_id"))
        .map(|x| {
            x.as_str()
                .map(|s| s.to_string())
                .unwrap_or_else(|| x.to_string().trim_matches('"').to_string())
        })
        .filter(|s| !s.is_empty())
}

/// Список файлов папки из офлайн-кэша (folder_*.json).
pub fn offline_list_folder_files(
    app: &AppHandle,
    folder_id: &str,
) -> Result<Vec<crate::infocard::InfocardFileHit>, String> {
    let root = offline_root(app)?;
    let Some(cache) = read_folder_cache(&root, folder_id.trim())? else {
        return Err("Папка не найдена в офлайн-базе".into());
    };
    let mut out = Vec::new();
    for item in &cache.files {
        let Some(id) = value_id(item) else { continue };
        let name = item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let status = item
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let has_pdf = item
            .get("hasPdf")
            .or_else(|| item.get("has_pdf"))
            .and_then(|v| v.as_bool())
            .or_else(|| {
                // Если PDF уже скачан в кэш — считаем готовым.
                cached_pdf_path(app, &id).ok().flatten().map(|_| true)
            });
        out.push(crate::infocard::InfocardFileHit {
            id,
            name,
            status,
            kind: Some("file".into()),
            folder_id: Some(folder_id.to_string()),
            folder_name: None,
            has_pdf,
        });
    }
    Ok(out)
}

/// Метаданные файла из офлайн-кэша (поиск по всем folder_*.json).
pub fn offline_get_file(
    app: &AppHandle,
    file_id: &str,
) -> Result<Option<crate::infocard::InfocardFileHit>, String> {
    let root = offline_root(app)?;
    let want = file_id.trim();
    if want.is_empty() {
        return Ok(None);
    }
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())?.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("folder_") || !name.ends_with(".json") {
            continue;
        }
        let text = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        let cache: FolderCache = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        for item in &cache.files {
            let Some(id) = value_id(item) else { continue };
            if id != want {
                continue;
            }
            let fname = item
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = item
                .get("status")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let has_pdf = item
                .get("hasPdf")
                .or_else(|| item.get("has_pdf"))
                .and_then(|v| v.as_bool())
                .or_else(|| cached_pdf_path(app, &id).ok().flatten().map(|_| true));
            return Ok(Some(crate::infocard::InfocardFileHit {
                id,
                name: fname,
                status,
                kind: Some("file".into()),
                folder_id: Some(cache.folder_id),
                folder_name: None,
                has_pdf,
            }));
        }
    }
    Ok(None)
}

pub fn offline_search(app: &AppHandle, query: &str, limit: u32) -> Result<Vec<OfflineSearchHit>, String> {
    let needle = query.trim().to_lowercase();
    if needle.len() < 2 {
        return Ok(vec![]);
    }
    let root = offline_root(app)?;
    let mut folder_names: HashMap<String, String> = HashMap::new();
    let mut hits: Vec<OfflineSearchHit> = Vec::new();

    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("folder_") || !name.ends_with(".json") {
            continue;
        }
        let text = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        let cache: FolderCache = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        for f in &cache.folders {
            if let (Some(id), Some(n)) = (f.get("id").or_else(|| f.get("_id")), f.get("name")) {
                if let (Some(id), Some(n)) = (id.as_str().or_else(|| id.as_i64().map(|_| "")), n.as_str()) {
                    let id = if id.is_empty() {
                        f.get("id").or_else(|| f.get("_id")).map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default()
                    } else {
                        id.to_string()
                    };
                    folder_names.insert(id, n.to_string());
                }
            }
        }
    }

    let entries = fs::read_dir(&root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("folder_") || !name.ends_with(".json") {
            continue;
        }
        let text = fs::read_to_string(entry.path()).map_err(|e| e.to_string())?;
        let cache: FolderCache = serde_json::from_str(&text).map_err(|e| e.to_string())?;
        let parent_name = if cache.folder_id == ROOTS_CACHE_ID {
            None
        } else {
            folder_names.get(&cache.folder_id).cloned()
        };

        for f in &cache.folders {
            let n = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let id = f
                .get("id")
                .or_else(|| f.get("_id"))
                .map(|v| {
                    v.as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| v.to_string().trim_matches('"').to_string())
                })
                .unwrap_or_default();
            if !id.is_empty() && n.to_lowercase().contains(&needle) {
                hits.push(OfflineSearchHit {
                    id,
                    name: n.to_string(),
                    kind: "folder".into(),
                    folder_id: None,
                    folder_name: None,
                    status: None,
                });
                if hits.len() as u32 >= limit {
                    return Ok(hits);
                }
            }
        }
        for f in &cache.files {
            let n = f.get("name").and_then(|v| v.as_str()).unwrap_or("");
            let id = f
                .get("id")
                .or_else(|| f.get("_id"))
                .map(|v| {
                    v.as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| v.to_string().trim_matches('"').to_string())
                })
                .unwrap_or_default();
            if !id.is_empty() && n.to_lowercase().contains(&needle) {
                hits.push(OfflineSearchHit {
                    id,
                    name: n.to_string(),
                    kind: "file".into(),
                    folder_id: if cache.folder_id == ROOTS_CACHE_ID {
                        None
                    } else {
                        Some(cache.folder_id.clone())
                    },
                    folder_name: parent_name.clone(),
                    status: f.get("status").and_then(|v| v.as_str()).map(|s| s.to_string()),
                });
                if hits.len() as u32 >= limit {
                    return Ok(hits);
                }
            }
        }
    }
    Ok(hits)
}

fn emit_progress(app: &AppHandle, progress: &OfflineProgress) {
    let _ = app.emit("infocard-offline-progress", progress);
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

fn load_all_children(
    base: &str,
    session: &mut InfocardSession,
    session_file: &PathBuf,
    folder_id: &str,
) -> Result<(Vec<serde_json::Value>, Vec<serde_json::Value>), String> {
    let mut folders = Vec::new();
    let mut files = Vec::new();

    for kind in ["folder", "file"] {
        let mut cursor: Option<String> = None;
        loop {
            let mut path = format!(
                "/folders/{}/children?type={}&limit=100",
                urlencoding_lite(folder_id),
                kind
            );
            if let Some(c) = &cursor {
                path.push_str(&format!("&cursor={}", urlencoding_lite(c)));
            }
            let resp = authorized_get(base, &path, session, session_file)?;
            let value: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
            if let Some(items) = value.get("items").and_then(|v| v.as_array()) {
                for item in items {
                    if kind == "folder" {
                        folders.push(item.clone());
                    } else {
                        files.push(item.clone());
                    }
                }
            }
            let has_more = value
                .get("hasMore")
                .or_else(|| value.get("has_more"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            cursor = value
                .get("nextCursor")
                .or_else(|| value.get("next_cursor"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty());
            if !has_more || cursor.is_none() {
                break;
            }
        }
    }
    Ok((folders, files))
}

fn has_current_pdf(root: &Path, file_id: &str, version_id: Option<&str>, pdf_size: Option<u64>) -> bool {
    let pdf = pdf_dir(root).join(format!("{file_id}.pdf"));
    if !pdf.is_file() {
        return false;
    }
    let marker_path = pdf_marker_path(root, file_id);
    if !marker_path.exists() {
        return false;
    }
    let marker = fs::read_to_string(&marker_path).unwrap_or_default();
    if let Some(v) = version_id {
        if marker.trim() == v {
            if let Some(size) = pdf_size {
                return pdf.metadata().map(|m| m.len() == size).unwrap_or(false);
            }
            return true;
        }
    }
    if let Some(size) = pdf_size {
        return pdf.metadata().map(|m| m.len() == size).unwrap_or(false);
    }
    false
}

#[tauri::command]
pub fn infocard_offline_get_meta(app: tauri::AppHandle) -> Result<Option<OfflineSyncMeta>, String> {
    get_sync_meta(&app)
}

#[tauri::command]
pub fn infocard_offline_search(
    app: tauri::AppHandle,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<OfflineSearchHit>, String> {
    offline_search(&app, &query, limit.unwrap_or(50))
}

#[tauri::command]
pub fn infocard_offline_sync(
    state: State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<OfflineSyncMeta, String> {
    let base = api_base(&state);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let session_file = session_path(&dir);
    let mut session = load_session(&session_file);
    if session.access_token.is_empty() {
        return Err("Не выполнен вход в Infocard".into());
    }

    let root = offline_root(&app)?;
    fs::create_dir_all(pdf_dir(&root)).map_err(|e| e.to_string())?;

    emit_progress(
        &app,
        &OfflineProgress {
            running: true,
            phase: "Подготовка…".into(),
            done: 0,
            total: 0,
            error: None,
        },
    );

    let summary_resp = authorized_get(&base, "/offline/summary", &mut session, &session_file)?;
    let summary: serde_json::Value = summary_resp.into_json().map_err(|e| e.to_string())?;
    let ready_count = summary.get("readyCount").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let bytes_total = summary.get("bytesTotal").and_then(|v| v.as_u64()).unwrap_or(0);

    emit_progress(
        &app,
        &OfflineProgress {
            running: true,
            phase: "Каталог папок…".into(),
            done: 0,
            total: 0,
            error: None,
        },
    );

    let tree_resp = authorized_get(&base, "/folders/tree", &mut session, &session_file)?;
    let tree: serde_json::Value = tree_resp.into_json().map_err(|e| e.to_string())?;
    let root_items = tree
        .get("items")
        .or_else(|| tree.get("folders"))
        .or_else(|| tree.get("roots"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let now = chrono::Utc::now().to_rfc3339();
    write_folder_cache(
        &root,
        &FolderCache {
            folder_id: ROOTS_CACHE_ID.into(),
            folders: root_items.clone(),
            files: vec![],
            saved_at: now.clone(),
            pinned: true,
        },
    )?;

    let mut queue: Vec<String> = root_items
        .iter()
        .filter_map(|f| {
            f.get("id")
                .or_else(|| f.get("_id"))
                .map(|v| v.as_str().map(|s| s.to_string()).unwrap_or_else(|| v.to_string().trim_matches('"').to_string()))
        })
        .collect();
    let mut idx = 0usize;
    while idx < queue.len() {
        let folder_id = queue[idx].clone();
        idx += 1;
        let (folders, files) = load_all_children(&base, &mut session, &session_file, &folder_id)?;
        write_folder_cache(
            &root,
            &FolderCache {
                folder_id: folder_id.clone(),
                folders,
                files,
                saved_at: now.clone(),
                pinned: true,
            },
        )?;
        emit_progress(
            &app,
            &OfflineProgress {
                running: true,
                phase: format!("Каталог папок… ({idx})"),
                done: idx as u32,
                total: 0,
                error: None,
            },
        );
        if let Some(cache) = read_folder_cache(&root, &folder_id)? {
            for f in cache.folders {
                if let Some(id) = f.get("id").or_else(|| f.get("_id")) {
                    let id = id
                        .as_str()
                        .map(|s| s.to_string())
                        .unwrap_or_else(|| id.to_string().trim_matches('"').to_string());
                    if !id.is_empty() {
                        queue.push(id);
                    }
                }
            }
        }
    }

    let mut cursor: Option<String> = None;
    let mut processed = 0u32;
    let mut downloaded = 0u32;
    let mut markers: HashMap<String, String> = HashMap::new();
    let mut active_ids: Vec<String> = Vec::new();

    loop {
        let mut path = "/offline/manifest?limit=50".to_string();
        if let Some(c) = &cursor {
            path.push_str(&format!("&cursor={}", urlencoding_lite(c)));
        }
        let resp = authorized_get(&base, &path, &mut session, &session_file)?;
        let page: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        let items = page
            .get("items")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            break;
        }

        for m in items {
            let file_id = m.get("id").map(|v| v.to_string().trim_matches('"').to_string()).unwrap_or_default();
            if file_id.is_empty() {
                continue;
            }
            active_ids.push(file_id.clone());
            let version_id = m.get("versionId").and_then(|v| v.as_str());
            let pdf_size = m.get("pdfSize").and_then(|v| v.as_u64());

            if !has_current_pdf(&root, &file_id, version_id, pdf_size) {
                let pdf_resp = authorized_get(
                    &base,
                    &format!("/files/{}/pdf", urlencoding_lite(&file_id)),
                    &mut session,
                    &session_file,
                )?;
                let dest = pdf_dir(&root).join(format!("{file_id}.pdf"));
                let mut reader = pdf_resp.into_reader();
                let mut file = fs::File::create(&dest).map_err(|e| e.to_string())?;
                std::io::copy(&mut reader, &mut file).map_err(|e| e.to_string())?;
                downloaded += 1;
            }
            if let Some(v) = version_id {
                markers.insert(file_id.clone(), v.to_string());
                fs::write(pdf_marker_path(&root, &file_id), v).ok();
            } else if let Some(size) = pdf_size {
                let marker = format!("size:{size}");
                markers.insert(file_id.clone(), marker.clone());
                fs::write(pdf_marker_path(&root, &file_id), marker).ok();
            }
            processed += 1;
            emit_progress(
                &app,
                &OfflineProgress {
                    running: true,
                    phase: format!(
                        "PDF… ({processed} / {ready_count}; обновлено {downloaded})"
                    ),
                    done: processed,
                    total: ready_count.max(processed),
                    error: None,
                },
            );
        }

        cursor = page
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .filter(|s| !s.is_empty());
        if cursor.is_none() {
            break;
        }
    }

    fs::write(
        manifest_path(&root),
        serde_json::to_string_pretty(&markers).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    // Prune stale PDFs
    if pdf_dir(&root).exists() {
        if let Ok(entries) = fs::read_dir(pdf_dir(&root)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".pdf") {
                    let id = name.strip_suffix(".pdf").unwrap_or(&name);
                    if !active_ids.iter().any(|x| x == id) {
                        let _ = fs::remove_file(entry.path());
                        let _ = fs::remove_file(pdf_marker_path(&root, id));
                    }
                }
            }
        }
    }

    // Cache markers
    if let Ok(resp) = authorized_get(&base, "/markers", &mut session, &session_file) {
        if let Ok(value) = resp.into_json::<serde_json::Value>() {
            let _ = fs::write(markers_path(&root), serde_json::to_string_pretty(&value).unwrap_or_default());
        }
    }

    let meta = OfflineSyncMeta {
        saved_at: chrono::Utc::now().to_rfc3339(),
        file_count: active_ids.len() as u32,
        bytes_total,
    };
    fs::write(
        meta_path(&root),
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    session.offline_sync_done = true;
    save_session(&session_file, &session)?;

    emit_progress(
        &app,
        &OfflineProgress {
            running: false,
            phase: if downloaded == 0 {
                "Готово — изменений нет".into()
            } else {
                "Готово".into()
            },
            done: processed,
            total: processed.max(ready_count),
            error: None,
        },
    );

    Ok(meta)
}

pub fn load_cached_markers(app: &AppHandle) -> Option<serde_json::Value> {
    let root = offline_root(app).ok()?;
    let path = markers_path(&root);
    if !path.exists() {
        return None;
    }
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}
