use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    #[serde(default)]
    pub data_path: String,
    #[serde(default = "default_provider")]
    pub map_provider: String,
    #[serde(default)]
    pub yandex_api_key: String,
    #[serde(default)]
    pub dgis_api_key: String,
    #[serde(default = "default_city")]
    pub default_city: String,
    #[serde(default = "default_lat")]
    pub default_lat: f64,
    #[serde(default = "default_lon")]
    pub default_lon: f64,
    #[serde(default = "default_zoom")]
    pub default_zoom: u32,
}

fn default_provider() -> String {
    "osm".into()
}
fn default_city() -> String {
    "Москва".into()
}
fn default_lat() -> f64 {
    55.7558
}
fn default_lon() -> f64 {
    37.6173
}
fn default_zoom() -> u32 {
    12
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            data_path: String::new(),
            map_provider: default_provider(),
            yandex_api_key: String::new(),
            dgis_api_key: String::new(),
            default_city: default_city(),
            default_lat: default_lat(),
            default_lon: default_lon(),
            default_zoom: default_zoom(),
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
