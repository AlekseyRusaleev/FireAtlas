mod db;
mod indexer;
mod kml;
mod local_map;
mod markers;
mod settings;

use db::Db;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use settings::{AppSettings, SettingsStore};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub store: SettingsStore,
    pub db: Mutex<Db>,
    pub map_pack_cancel: Arc<AtomicBool>,
    pub map_pack_running: AtomicBool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WaterType {
    Hydrant,
    Pond,
    Tower,
    Pier,
    Other,
}

impl WaterType {
    pub fn as_str(&self) -> &'static str {
        match self {
            WaterType::Hydrant => "hydrant",
            WaterType::Pond => "pond",
            WaterType::Tower => "tower",
            WaterType::Pier => "pier",
            WaterType::Other => "other",
        }
    }

    pub fn from_str_loose(s: &str) -> Self {
        let t = s.to_lowercase();
        if t.contains("гидрант")
            || t.contains("hydrant")
            || t.contains("пг")
            || t.contains("пожарный гидрант")
        {
            WaterType::Hydrant
        } else if t.contains("водоем")
            || t.contains("водоём")
            || t.contains("пруд")
            || t.contains("pond")
            || t.contains("озеро")
            || t.contains("водоист")
            || t.contains("открыт")
        {
            WaterType::Pond
        } else if t.contains("башн")
            || t.contains("tower")
            || t.contains("водонапор")
            || t.contains("вб")
        {
            WaterType::Tower
        } else if t.contains("пирс")
            || t.contains("pier")
            || t.contains("причал")
            || t.contains("набер")
        {
            WaterType::Pier
        } else {
            WaterType::Other
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexStats {
    pub water_points: i64,
    pub cards: i64,
    pub sources: i64,
    pub last_indexed_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReindexReport {
    pub water_points: i64,
    pub cards: i64,
    pub sources: i64,
    pub files_found: usize,
    pub files_ok: usize,
    pub files_failed: usize,
    pub points_parsed: usize,
    pub scanned_dirs: Vec<String>,
    pub errors: Vec<String>,
    pub last_indexed_at: Option<String>,
    pub hint: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchHit {
    pub id: i64,
    pub kind: String,
    pub title: String,
    pub subtitle: String,
    pub water_type: Option<String>,
    pub address: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub distance_m: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WaterPointDto {
    pub id: i64,
    pub name: String,
    pub water_type: String,
    pub lat: f64,
    pub lon: f64,
    pub address: Option<String>,
    pub description: Option<String>,
    pub source_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardFileDto {
    pub id: i64,
    pub kind: String,
    pub path: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardDto {
    pub id: i64,
    pub title: String,
    pub address: Option<String>,
    pub district: Option<String>,
    pub number: Option<String>,
    pub lat: Option<f64>,
    pub lon: Option<f64>,
    pub folder_path: String,
    pub files: Vec<CardFileDto>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserMarkerDto {
    pub id: i64,
    pub name: String,
    pub comment: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkerFileInfo {
    pub path: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarkersState {
    pub markers: Vec<UserMarkerDto>,
    pub file: Option<MarkerFileInfo>,
    pub file_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDto {
    pub id: i64,
    pub path: String,
    pub kind: String,
    pub mtime: i64,
    pub status: String,
    pub point_count: i64,
    pub file_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NearbyPoint {
    pub id: i64,
    pub name: String,
    pub water_type: String,
    pub lat: f64,
    pub lon: f64,
    pub distance_m: f64,
}

fn app_data_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))
}

#[tauri::command]
fn get_settings(state: tauri::State<'_, Arc<AppState>>) -> AppSettings {
    state.settings.lock().clone()
}

#[tauri::command]
fn save_settings(
    state: tauri::State<'_, Arc<AppState>>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    state.store.save(&settings)?;
    *state.settings.lock() = settings.clone();
    Ok(settings)
}

#[tauri::command]
fn get_stats(state: tauri::State<'_, Arc<AppState>>) -> Result<IndexStats, String> {
    state.db.lock().stats()
}

#[tauri::command]
async fn reindex(state: tauri::State<'_, Arc<AppState>>) -> Result<ReindexReport, String> {
    let data_path = state.settings.lock().data_path.clone();
    if data_path.trim().is_empty() {
        return Err("Укажите путь к базе в настройках и нажмите «Сохранить»".into());
    }
    let state = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let mut db = state.db.lock();
        let report = indexer::reindex_all(&mut db, PathBuf::from(&data_path))?;
        Ok(ReindexReport {
            water_points: report.water_points,
            cards: report.cards,
            sources: report.sources,
            files_found: report.files_found,
            files_ok: report.files_ok,
            files_failed: report.files_failed,
            points_parsed: report.points_parsed,
            scanned_dirs: report.scanned_dirs,
            errors: report.errors,
            last_indexed_at: report.last_indexed_at,
            hint: report.hint,
        })
    })
    .await
    .map_err(|e| format!("ошибка потока индексации: {e}"))?
}

#[tauri::command]
async fn import_kmz_files(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ReindexReport, String> {
    use tauri_plugin_dialog::DialogExt;

    let data_path = state.settings.lock().data_path.clone();
    if data_path.trim().is_empty() {
        return Err("Сначала укажите и сохраните путь к базе".into());
    }

    let files = app
        .dialog()
        .file()
        .add_filter("Карты KML/KMZ", &["kml", "kmz"])
        .blocking_pick_files();

    let Some(files) = files else {
        return Ok(ReindexReport {
            water_points: state.db.lock().stats()?.water_points,
            cards: state.db.lock().stats()?.cards,
            sources: state.db.lock().stats()?.sources,
            files_found: 0,
            files_ok: 0,
            files_failed: 0,
            points_parsed: 0,
            scanned_dirs: vec![],
            errors: vec![],
            last_indexed_at: state.db.lock().stats()?.last_indexed_at,
            hint: "Импорт отменён".into(),
        });
    };

    let paths: Vec<PathBuf> = files
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .collect();

    if paths.is_empty() {
        return Err("Не удалось получить пути к выбранным файлам".into());
    }

    let state = Arc::clone(&state);
    let root = PathBuf::from(data_path);
    tauri::async_runtime::spawn_blocking(move || {
        let mut db = state.db.lock();
        let n = indexer::import_map_files(&mut db, &root, &paths)?;
        let stats = db.stats()?;
        Ok(ReindexReport {
            water_points: stats.water_points,
            cards: stats.cards,
            sources: stats.sources,
            files_found: n,
            files_ok: n,
            files_failed: 0,
            points_parsed: stats.water_points as usize,
            scanned_dirs: vec![root.join("KMZ").display().to_string()],
            errors: vec![],
            last_indexed_at: stats.last_indexed_at,
            hint: format!(
                "Импортировано файлов: {n}. ИППВ в индексе: {}.",
                stats.water_points
            ),
        })
    })
    .await
    .map_err(|e| format!("ошибка импорта: {e}"))?
}

#[tauri::command]
async fn import_kmz_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<ReindexReport, String> {
    use tauri_plugin_dialog::DialogExt;

    let data_path = state.settings.lock().data_path.clone();
    if data_path.trim().is_empty() {
        return Err("Сначала укажите и сохраните путь к базе".into());
    }

    let folder = app.dialog().file().blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(ReindexReport {
            water_points: state.db.lock().stats()?.water_points,
            cards: state.db.lock().stats()?.cards,
            sources: state.db.lock().stats()?.sources,
            files_found: 0,
            files_ok: 0,
            files_failed: 0,
            points_parsed: 0,
            scanned_dirs: vec![],
            errors: vec![],
            last_indexed_at: state.db.lock().stats()?.last_indexed_at,
            hint: "Импорт отменён".into(),
        });
    };
    let folder = folder
        .into_path()
        .map_err(|e| format!("путь к папке: {e}"))?;

    let state = Arc::clone(&state);
    let root = PathBuf::from(data_path);
    tauri::async_runtime::spawn_blocking(move || {
        let paths = indexer::collect_map_files_flat(&folder);
        if paths.is_empty() {
            return Err(
                "В выбранной папке нет файлов .kml/.kmz. Выберите папку, где лежат KMZ (например «Загрузки»), или используйте «Добавить файлы KML/KMZ…»."
                    .into(),
            );
        }
        let mut db = state.db.lock();
        let n = indexer::import_map_files(&mut db, &root, &paths)?;
        let stats = db.stats()?;
        Ok(ReindexReport {
            water_points: stats.water_points,
            cards: stats.cards,
            sources: stats.sources,
            files_found: paths.len(),
            files_ok: n,
            files_failed: paths.len().saturating_sub(n),
            points_parsed: stats.water_points as usize,
            scanned_dirs: vec![folder.display().to_string()],
            errors: vec![],
            last_indexed_at: stats.last_indexed_at,
            hint: format!(
                "Импортировано файлов: {n} из {}. ИППВ в индексе: {}.",
                paths.len(),
                stats.water_points
            ),
        })
    })
    .await
    .map_err(|e| format!("ошибка импорта папки: {e}"))?
}

#[tauri::command]
fn search(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    types: Vec<String>,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, String> {
    state
        .db
        .lock()
        .search(&query, &types, limit.unwrap_or(50))
}

#[tauri::command]
fn get_water_in_bounds(
    state: tauri::State<'_, Arc<AppState>>,
    min_lat: f64,
    min_lon: f64,
    max_lat: f64,
    max_lon: f64,
    types: Vec<String>,
) -> Result<Vec<WaterPointDto>, String> {
    state
        .db
        .lock()
        .water_in_bounds(min_lat, min_lon, max_lat, max_lon, &types)
}

#[tauri::command]
fn get_water_point(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Option<WaterPointDto>, String> {
    state.db.lock().get_water(id)
}

#[tauri::command]
fn get_card(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<Option<CardDto>, String> {
    state.db.lock().get_card(id)
}

#[tauri::command]
fn list_cards(
    state: tauri::State<'_, Arc<AppState>>,
    query: String,
    limit: Option<i64>,
) -> Result<Vec<CardDto>, String> {
    state.db.lock().list_cards(&query, limit.unwrap_or(100))
}

#[tauri::command]
fn nearby(
    state: tauri::State<'_, Arc<AppState>>,
    lat: f64,
    lon: f64,
    limit: Option<i64>,
    types: Vec<String>,
) -> Result<Vec<NearbyPoint>, String> {
    state
        .db
        .lock()
        .nearby(lat, lon, limit.unwrap_or(10), &types)
}

#[tauri::command]
fn add_history(
    state: tauri::State<'_, Arc<AppState>>,
    kind: String,
    id: i64,
    title: String,
) -> Result<(), String> {
    state.db.lock().add_history(&kind, id, &title)
}

#[tauri::command]
fn get_history(
    state: tauri::State<'_, Arc<AppState>>,
    limit: Option<i64>,
) -> Result<Vec<SearchHit>, String> {
    state.db.lock().get_history(limit.unwrap_or(20))
}

#[tauri::command]
fn toggle_favorite(
    state: tauri::State<'_, Arc<AppState>>,
    kind: String,
    id: i64,
    title: String,
) -> Result<bool, String> {
    state.db.lock().toggle_favorite(&kind, id, &title)
}

#[tauri::command]
fn get_favorites(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SearchHit>, String> {
    state.db.lock().get_favorites()
}

/// Отдаёт метки из БД и, при необходимости, обновляет KML-файл рядом с базой.
/// Блокировки берём по очереди: parking_lot::Mutex не реентрантный.
fn markers_state(state: &AppState, force_write: bool) -> Result<MarkersState, String> {
    let list = state.db.lock().list_user_markers()?;
    let data_path = state.settings.lock().data_path.clone();

    let Some(path) = markers::markers_file_path(&data_path) else {
        return Ok(MarkersState {
            markers: list,
            file: None,
            file_error: None,
        });
    };

    // При обычном чтении файл не перезаписываем — только восстанавливаем, если он исчез.
    // Метка уже в базе, поэтому недоступный сетевой диск не должен ломать сохранение.
    let mut file_error = None;
    if force_write || (!path.exists() && !list.is_empty()) {
        if let Err(e) = markers::write_markers_kml(&path, &list) {
            file_error = Some(e);
        }
    }

    Ok(MarkersState {
        file: Some(MarkerFileInfo {
            path: path.display().to_string(),
            count: list.len(),
        }),
        markers: list,
        file_error,
    })
}

#[tauri::command]
fn list_sources(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SourceDto>, String> {
    state.db.lock().list_sources()
}

#[tauri::command]
fn delete_source(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Vec<SourceDto>, String> {
    state.db.lock().delete_source(id)?;
    state.db.lock().list_sources()
}

#[tauri::command]
fn list_markers(state: tauri::State<'_, Arc<AppState>>) -> Result<MarkersState, String> {
    markers_state(&state, true)
}

#[tauri::command]
fn add_marker(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    comment: Option<String>,
    lat: f64,
    lon: f64,
) -> Result<MarkersState, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Укажите название метки".into());
    }
    if !lat.is_finite() || !lon.is_finite() {
        return Err("Некорректные координаты метки".into());
    }
    let comment = comment
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());
    let created_at = chrono::Local::now().to_rfc3339();

    state
        .db
        .lock()
        .add_user_marker(name, comment.as_deref(), lat, lon, &created_at)?;

    markers_state(&state, true)
}

#[tauri::command]
fn delete_marker(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<MarkersState, String> {
    state.db.lock().delete_user_marker(id)?;
    markers_state(&state, true)
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Файл не найден (облако не скачало?): {path}"));
    }
    // ShellExecuteExW принимает путь как UTF-16, поэтому кириллица, кавычки и
    // сетевые диски (Z:) не искажаются — в отличие от `cmd /C start`.
    open::that_detached(&p).map_err(|e| format!("не удалось открыть «{path}»: {e}"))
}

#[tauri::command]
fn open_folder(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let folder = if p.is_file() {
        p.parent()
            .map(|x| x.to_path_buf())
            .unwrap_or_else(|| p.clone())
    } else {
        p
    };
    if !folder.exists() {
        return Err(format!("Папка не найдена: {}", folder.display()));
    }
    open::that_detached(&folder)
        .map_err(|e| format!("не удалось открыть папку «{}»: {e}", folder.display()))
}

#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("read {path}: {e}"))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

#[tauri::command]
fn pick_data_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    Ok(folder.and_then(|p| p.into_path().ok().map(|path| path.to_string_lossy().into_owned())))
}

#[tauri::command]
fn list_map_cities() -> Vec<local_map::MapCity> {
    local_map::cities()
}

#[tauri::command]
fn resolve_city(
    query: String,
    radius_km: Option<f64>,
) -> Result<local_map::MapCity, String> {
    local_map::resolve_city_query(&query, radius_km)
}

#[tauri::command]
fn list_map_packages(app: tauri::AppHandle) -> Result<Vec<local_map::MapPackageInfo>, String> {
    let maps_parent = app_data_dir(&app)?;
    local_map::list_packages(maps_parent.as_path())
}

#[tauri::command]
fn prepare_map_package(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    city_name: String,
    radius_km: Option<f64>,
) -> Result<(), String> {
    if state
        .map_pack_running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err(
            "Уже идёт скачивание пакета. Дождитесь окончания или нажмите «Отменить».".into(),
        );
    }

    let maps_parent = match app_data_dir(&app) {
        Ok(p) => p,
        Err(e) => {
            state.map_pack_running.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };

    state.map_pack_cancel.store(false, Ordering::Relaxed);
    let cancel = Arc::clone(&state.map_pack_cancel);
    let app2 = app.clone();
    let state2 = Arc::clone(&state);

    tauri::async_runtime::spawn(async move {
        let app_for_block = app2.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            local_map::prepare_package(app_for_block, maps_parent, city_name, radius_km, cancel)
        })
        .await;

        match result {
            Ok(Ok(info)) => {
                let mut settings = state2.settings.lock().clone();
                settings.local_map_city_id = info.id.clone();
                settings.local_map_path = info.path.clone();
                settings.map_provider = "local".into();
                settings.default_city = info.name.clone();
                settings.default_lat = info.lat;
                settings.default_lon = info.lon;
                settings.default_zoom = info.zoom;
                let _ = state2.store.save(&settings);
                *state2.settings.lock() = settings;
                let _ = app2.emit(
                    "map-pack-finished",
                    local_map::MapPackageInfo {
                        id: info.id,
                        name: info.name,
                        path: info.path,
                        lat: info.lat,
                        lon: info.lon,
                        zoom: info.zoom,
                        min_zoom: info.min_zoom,
                        max_zoom: info.max_zoom,
                        tile_count: info.tile_count,
                        ready: true,
                    },
                );
            }
            Ok(Err(e)) => {
                let _ = app2.emit(
                    "map-pack-progress",
                    local_map::MapPackProgress {
                        city_id: String::new(),
                        city_name: String::new(),
                        current: 0,
                        total: 0,
                        message: e.clone(),
                        done: true,
                        error: Some(e),
                    },
                );
            }
            Err(e) => {
                let msg = format!("поток подготовки карты: {e}");
                let _ = app2.emit(
                    "map-pack-progress",
                    local_map::MapPackProgress {
                        city_id: String::new(),
                        city_name: String::new(),
                        current: 0,
                        total: 0,
                        message: msg.clone(),
                        done: true,
                        error: Some(msg),
                    },
                );
            }
        }
        state2.map_pack_running.store(false, Ordering::SeqCst);
    });

    Ok(())
}

#[tauri::command]
fn cancel_map_package(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    state.map_pack_cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn import_map_package_zip(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<local_map::MapPackageInfo, String> {
    use tauri_plugin_dialog::DialogExt;
    let maps_parent = app_data_dir(&app)?;
    let file = app
        .dialog()
        .file()
        .add_filter("Пакет карты", &["zip"])
        .blocking_pick_file();
    let Some(file) = file else {
        return Err("Файл не выбран".into());
    };
    let path = file
        .into_path()
        .map_err(|e| format!("путь к файлу: {e}"))?;
    let info = tauri::async_runtime::spawn_blocking(move || {
        local_map::import_package_zip(&maps_parent, &path)
    })
    .await
    .map_err(|e| format!("импорт: {e}"))??;

    let mut settings = state.settings.lock().clone();
    settings.local_map_city_id = info.id.clone();
    settings.local_map_path = info.path.clone();
    settings.map_provider = "local".into();
    settings.default_city = info.name.clone();
    settings.default_lat = info.lat;
    settings.default_lon = info.lon;
    settings.default_zoom = info.zoom;
    state.store.save(&settings)?;
    *state.settings.lock() = settings;
    Ok(info)
}

#[tauri::command]
async fn export_map_package_zip(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    package_path: Option<String>,
) -> Result<String, String> {
    use tauri_plugin_dialog::DialogExt;
    let settings = state.settings.lock().clone();
    let pkg = package_path
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| settings.local_map_path.clone());
    if pkg.trim().is_empty() {
        return Err("Нет активного пакета карты".into());
    }
    let default_name = format!("{}.zip", settings.local_map_city_id);
    let save = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .add_filter("ZIP", &["zip"])
        .blocking_save_file();
    let Some(save) = save else {
        return Err("Сохранение отменено".into());
    };
    let zip_path = save
        .into_path()
        .map_err(|e| format!("путь сохранения: {e}"))?;
    let pkg_path = PathBuf::from(pkg);
    tauri::async_runtime::spawn_blocking(move || {
        local_map::export_package_zip(&pkg_path, &zip_path)?;
        Ok(zip_path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| format!("экспорт: {e}"))?
}

#[tauri::command]
fn pick_map_package_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<local_map::MapPackageInfo, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app.dialog().file().blocking_pick_folder();
    let Some(folder) = folder else {
        return Err("Папка не выбрана".into());
    };
    let path = folder
        .into_path()
        .map_err(|e| format!("путь: {e}"))?;
    let meta = local_map::read_meta(&path)?;
    let info = local_map::MapPackageInfo {
        id: meta.id.clone(),
        name: meta.name.clone(),
        path: path.to_string_lossy().into_owned(),
        lat: meta.lat,
        lon: meta.lon,
        zoom: meta.zoom,
        min_zoom: meta.min_zoom,
        max_zoom: meta.max_zoom,
        tile_count: meta.tile_count,
        ready: true,
    };
    let mut settings = state.settings.lock().clone();
    settings.local_map_city_id = info.id.clone();
    settings.local_map_path = info.path.clone();
    settings.map_provider = "local".into();
    settings.default_city = info.name.clone();
    settings.default_lat = info.lat;
    settings.default_lon = info.lon;
    settings.default_zoom = info.zoom;
    state.store.save(&settings)?;
    *state.settings.lock() = settings;
    Ok(info)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let data_dir = app_data_dir(app.handle())?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("create app data: {e}"))?;

            let store = SettingsStore::new(data_dir.join("settings.json"));
            let settings = store.load().unwrap_or_default();
            let db = Db::open(data_dir.join("atlas.db"))?;

            let state = Arc::new(AppState {
                settings: Mutex::new(settings),
                store,
                db: Mutex::new(db),
                map_pack_cancel: Arc::new(AtomicBool::new(false)),
                map_pack_running: AtomicBool::new(false),
            });
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            save_settings,
            get_stats,
            reindex,
            import_kmz_files,
            import_kmz_folder,
            list_sources,
            delete_source,
            search,
            get_water_in_bounds,
            get_water_point,
            get_card,
            list_cards,
            nearby,
            add_history,
            get_history,
            toggle_favorite,
            get_favorites,
            list_markers,
            add_marker,
            delete_marker,
            open_path,
            open_folder,
            read_file_base64,
            pick_data_folder,
            list_map_cities,
            resolve_city,
            list_map_packages,
            prepare_map_package,
            cancel_map_package,
            import_map_package_zip,
            export_map_package_zip,
            pick_map_package_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
