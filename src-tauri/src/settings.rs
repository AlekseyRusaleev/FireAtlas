use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub data_path: String,
    pub map_provider: String,
    pub yandex_api_key: String,
    pub dgis_api_key: String,
    pub default_lat: f64,
    pub default_lon: f64,
    pub default_zoom: u32,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            data_path: String::new(),
            // UI currently renders OSM; yandex preferred when key is set later
            map_provider: "yandex".into(),
            yandex_api_key: String::new(),
            dgis_api_key: String::new(),
            default_lat: 55.75,
            default_lon: 37.62,
            default_zoom: 11,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
}

impl SettingsStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> Result<AppSettings, String> {
        if !self.path.exists() {
            return Ok(AppSettings::default());
        }
        let raw = fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        serde_json::from_str(&raw).map_err(|e| e.to_string())
    }

    pub fn save(&self, settings: &AppSettings) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        fs::write(&self.path, raw).map_err(|e| e.to_string())
    }
}
