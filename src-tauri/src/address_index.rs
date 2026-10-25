//! Локальный адресный индекс: SQLite с точками «улица + дом», без Nominatim.

use rusqlite::{params_from_iter, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, State};
use std::sync::Arc;

use crate::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AddressPlace {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub region: String,
    pub file: String,
    pub lat: f64,
    pub lon: f64,
    pub radius_km: f64,
    pub count: u32,
}

#[derive(Debug, Deserialize)]
struct AddressCatalog {
    places: Vec<AddressPlace>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AddressHit {
    pub lat: f64,
    pub lon: f64,
    pub label: String,
    pub street: String,
    pub house: String,
    pub city: String,
}

fn address_dirs(app: &AppHandle, data_path: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.join("addresses"));
            dirs.push(dir.join("../../../dist-app/addresses"));
            dirs.push(dir.join("../../../../dist-app/addresses"));
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        dirs.push(cwd.join("dist-app/addresses"));
        dirs.push(cwd.join("../dist-app/addresses"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        dirs.push(data.join("addresses"));
    }
    if !data_path.trim().is_empty() {
        dirs.push(PathBuf::from(data_path).join("addresses"));
    }
    dirs
}

fn list_packs(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(rd) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("sqlite") {
                out.push(path);
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn like_pattern(token: &str) -> String {
    let mut escaped = String::new();
    for ch in token.chars() {
        if ch == '%' || ch == '_' || ch == '\\' {
            escaped.push('\\');
        }
        escaped.push(ch);
    }
    format!("%{escaped}%")
}

fn resolve_rel(root: &Path, rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains("..") {
        return Err("некорректный путь пакета".into());
    }
    let mut path = root.to_path_buf();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            return Err("некорректный путь пакета".into());
        }
        path.push(part);
    }
    Ok(path)
}

fn load_catalogs(dirs: &[PathBuf]) -> Vec<(PathBuf, Vec<AddressPlace>)> {
    let mut out = Vec::new();
    for dir in dirs {
        let file = dir.join("catalog.json");
        let Ok(raw) = std::fs::read_to_string(&file) else {
            continue;
        };
        let Ok(catalog) = serde_json::from_str::<AddressCatalog>(&raw) else {
            continue;
        };
        out.push((dir.clone(), catalog.places));
    }
    out.sort_by_key(|(_, places)| std::cmp::Reverse(places.len()));
    out
}

fn query_pack(
    path: &Path,
    tokens: &[String],
    house: Option<&str>,
    center_lat: f64,
    center_lon: f64,
    bounds: Option<(f64, f64, f64, f64)>,
    limit: u32,
) -> Result<Vec<AddressHit>, String> {
    let conn = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    let mut sql = String::from("SELECT city, street, house, lat, lon FROM addresses WHERE 1=1");
    let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    if let Some((south, north, west, east)) = bounds {
        sql.push_str(" AND lat BETWEEN ?1 AND ?2 AND lon BETWEEN ?3 AND ?4");
        values.push(Box::new(south));
        values.push(Box::new(north));
        values.push(Box::new(west));
        values.push(Box::new(east));
    }
    if let Some(house) = house {
        sql.push_str(&format!(" AND house = ?{}", values.len() + 1));
        values.push(Box::new(house.to_string()));
    }
    for token in tokens {
        sql.push_str(&format!(
            " AND street_key LIKE ?{} ESCAPE '\\'",
            values.len() + 1
        ));
        values.push(Box::new(like_pattern(token)));
    }
    let lat_idx = values.len() + 1;
    let lon_idx = values.len() + 2;
    values.push(Box::new(center_lat));
    values.push(Box::new(center_lon));
    sql.push_str(&format!(
        " ORDER BY ((lat - ?{lat_idx}) * (lat - ?{lat_idx}) + (lon - ?{lon_idx}) * (lon - ?{lon_idx})) LIMIT {limit}"
    ));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params_from_iter(values.iter().map(|v| v.as_ref())), |row| {
            let city: String = row.get(0)?;
            let street: String = row.get(1)?;
            let house: String = row.get(2)?;
            let lat: f64 = row.get(3)?;
            let lon: f64 = row.get(4)?;
            Ok(AddressHit {
                label: format!("{street}, {house}, {city}"),
                city,
                street,
                house,
                lat,
                lon,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

fn bounds(lat: f64, lon: f64, radius_km: f64) -> (f64, f64, f64, f64) {
    let d_lat = radius_km / 111.32;
    let cos = (lat.to_radians().cos()).max(0.2);
    let d_lon = radius_km / (111.32 * cos);
    (lat - d_lat, lat + d_lat, lon - d_lon, lon + d_lon)
}

#[tauri::command]
pub fn list_address_places(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<Vec<AddressPlace>, String> {
    let data_path = state.settings.lock().data_path.clone();
    let catalogs = load_catalogs(&address_dirs(&app, &data_path));
    Ok(catalogs.into_iter().next().map(|(_, places)| places).unwrap_or_default())
}

#[tauri::command]
pub fn search_address_pack(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    street_tokens: Vec<String>,
    house: Option<String>,
    lat: f64,
    lon: f64,
    radius_km: Option<f64>,
    place_id: Option<String>,
    limit: Option<u32>,
) -> Result<Vec<AddressHit>, String> {
    let tokens: Vec<String> = street_tokens
        .into_iter()
        .map(|t| t.trim().to_lowercase().replace('ё', "е"))
        .filter(|t| t.chars().count() >= 3)
        .collect();
    if tokens.is_empty() {
        return Ok(vec![]);
    }
    let house = house
        .map(|h| h.trim().to_lowercase().replace(' ', "").replace('ё', "е"))
        .filter(|h| !h.is_empty());
    let data_path = state.settings.lock().data_path.clone();
    let dirs = address_dirs(&app, &data_path);
    let cap = limit.unwrap_or(40).clamp(1, 80);
    let place_id = place_id.unwrap_or_default();

    if !place_id.is_empty() {
        let catalogs = load_catalogs(&dirs);
        let Some((root, places)) = catalogs.into_iter().next() else {
            return Ok(vec![]);
        };
        let Some(place) = places.into_iter().find(|p| p.id == place_id) else {
            return Ok(vec![]);
        };
        let path = resolve_rel(&root, &place.file)?;
        if !path.is_file() {
            return Ok(vec![]);
        }
        let center_lat = if lat.abs() < 0.01 { place.lat } else { lat };
        let center_lon = if lon.abs() < 0.01 { place.lon } else { lon };
        let bounds = if place.kind == "region" {
            None
        } else {
            let radius = radius_km
                .unwrap_or(place.radius_km)
                .clamp(5.0, 160.0);
            let (south, north, west, east) = bounds(center_lat, center_lon, radius);
            Some((south, north, west, east))
        };
        return query_pack(
            &path,
            &tokens,
            house.as_deref(),
            center_lat,
            center_lon,
            bounds,
            cap,
        );
    }

    let radius = radius_km.unwrap_or(50.0).clamp(1.0, 80.0);
    let box_bounds = if lat.abs() < 0.01 && lon.abs() < 0.01 {
        None
    } else {
        let (south, north, west, east) = bounds(lat, lon, radius);
        Some((south, north, west, east))
    };
    let packs = list_packs(&dirs);
    let mut hits = Vec::new();
    for pack in packs {
        let mut part = query_pack(
            &pack,
            &tokens,
            house.as_deref(),
            lat,
            lon,
            box_bounds,
            cap,
        )?;
        hits.append(&mut part);
        if hits.len() >= cap as usize {
            break;
        }
    }
    hits.truncate(cap as usize);
    Ok(hits)
}
