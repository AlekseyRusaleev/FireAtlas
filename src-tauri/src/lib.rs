mod db;
mod indexer;
mod kml;
mod settings;

use db::Db;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use settings::{AppSettings, SettingsStore};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

pub struct AppState {
    pub settings: Mutex<AppSettings>,
    pub store: SettingsStore,
    pub db: Mutex<Db>,
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
        // Full reindex report after import
        let report = indexer::reindex_all(&mut db, root)?;
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
            hint: format!("Импортировано файлов: {n}. {}", report.hint),
        })
    })
    .await
    .map_err(|e| format!("ошибка импорта: {e}"))?
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

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    open::that(&path).map_err(|e| format!("open failed: {e}"))
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
            open_path,
            read_file_base64,
            pick_data_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
