use chrono::Local;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapCity {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub zoom: u32,
    pub radius_km: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapPackageMeta {
    pub id: String,
    pub name: String,
    pub lat: f64,
    pub lon: f64,
    pub zoom: u32,
    pub min_zoom: u32,
    pub max_zoom: u32,
    pub south: f64,
    pub west: f64,
    pub north: f64,
    pub east: f64,
    pub tile_count: u32,
    pub created_at: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapPackageInfo {
    pub id: String,
    pub name: String,
    pub path: String,
    pub lat: f64,
    pub lon: f64,
    pub zoom: u32,
    pub min_zoom: u32,
    pub max_zoom: u32,
    pub tile_count: u32,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MapPackProgress {
    pub city_id: String,
    pub city_name: String,
    pub current: u32,
    pub total: u32,
    pub message: String,
    pub done: bool,
    pub error: Option<String>,
}

pub fn cities() -> Vec<MapCity> {
    const RAW: &[(&str, &str, f64, f64, u32, f64)] = &[
        ("kemerovo", "Кемерово", 55.3549, 86.0885, 12, 18.0),
        ("novokuznetsk", "Новокузнецк", 53.7596, 87.1216, 12, 18.0),
        ("tomsk", "Томск", 56.4846, 84.9476, 12, 16.0),
        ("barnaul", "Барнаул", 53.3468, 83.7768, 12, 16.0),
        ("novosibirsk", "Новосибирск", 55.0084, 82.9357, 11, 22.0),
        ("krasnoyarsk", "Красноярск", 56.0153, 92.8932, 11, 20.0),
        ("moscow", "Москва", 55.7558, 37.6173, 11, 25.0),
        ("spb", "Санкт-Петербург", 59.9343, 30.3351, 11, 22.0),
        ("ekaterinburg", "Екатеринбург", 56.8389, 60.6057, 11, 18.0),
        ("kazan", "Казань", 55.7961, 49.1064, 12, 16.0),
        ("nizhny", "Нижний Новгород", 56.2965, 43.9361, 12, 16.0),
        ("chelyabinsk", "Челябинск", 55.1644, 61.4368, 11, 18.0),
        ("samara", "Самара", 53.1959, 50.1002, 12, 16.0),
        ("omsk", "Омск", 54.9885, 73.3242, 11, 18.0),
        ("rostov", "Ростов-на-Дону", 47.2357, 39.7015, 12, 16.0),
        ("ufa", "Уфа", 54.7388, 55.9721, 12, 16.0),
        ("voronezh", "Воронеж", 51.6720, 39.1843, 12, 14.0),
        ("perm", "Пермь", 58.0105, 56.2502, 12, 16.0),
        ("volgograd", "Волгоград", 48.7080, 44.5133, 12, 16.0),
        ("krasnodar", "Краснодар", 45.0355, 38.9753, 12, 14.0),
        ("tyumen", "Тюмень", 57.1522, 65.5272, 12, 14.0),
        ("irkutsk", "Иркутск", 52.2869, 104.3050, 12, 14.0),
        ("khabarovsk", "Хабаровск", 48.4827, 135.0838, 12, 14.0),
        ("vladivostok", "Владивосток", 43.1155, 131.8855, 12, 14.0),
    ];
    RAW.iter()
        .map(|(id, name, lat, lon, zoom, r)| MapCity {
            id: (*id).into(),
            name: (*name).into(),
            lat: *lat,
            lon: *lon,
            zoom: *zoom,
            radius_km: *r,
        })
        .collect()
}

pub fn find_city(id_or_name: &str) -> Option<MapCity> {
    let q = id_or_name.trim().to_lowercase();
    if q.is_empty() {
        return None;
    }
    let all = cities();
    if let Some(c) = all.iter().find(|c| c.id == q || c.name.to_lowercase() == q) {
        return Some(c.clone());
    }
    // Prefix match only for longer queries — avoid "ск" → random city / Кемерово
    if q.chars().count() >= 4 {
        if let Some(c) = all
            .iter()
            .find(|c| c.name.to_lowercase().starts_with(&q) || c.id.starts_with(&q))
        {
            return Some(c.clone());
        }
    }
    None
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn slugify(name: &str, lat: f64, lon: f64) -> String {
    let cleaned: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'а'..='я' | 'ё' | 'a'..='z' | '0'..='9' => c,
            ' ' | '-' | '_' | '.' => '_',
            _ => '_',
        })
        .collect::<String>()
        .trim_matches('_')
        .chars()
        .take(48)
        .collect();
    if cleaned.is_empty() {
        format!(
            "city_{}_{}",
            format!("{lat:.4}").replace('.', "p"),
            format!("{lon:.4}").replace('.', "p")
        )
    } else {
        cleaned
    }
}

#[derive(Debug, Deserialize)]
struct NominatimHit {
    lat: String,
    lon: String,
    display_name: String,
}

/// Resolve a free-typed city name (known list first, then Nominatim via curl).
pub fn resolve_city_query(query: &str, radius_km: Option<f64>) -> Result<MapCity, String> {
    let q = query.trim();
    if q.is_empty() {
        return Err("Введите название города".into());
    }
    let r = radius_km.unwrap_or(16.0).clamp(5.0, 35.0);

    if let Some(mut c) = find_city(q) {
        c.radius_km = r;
        // Keep the name the user typed if it's an exact/known city
        if c.name.to_lowercase() != q.to_lowercase() && q.chars().count() >= 3 {
            // prefix match — use canonical name from list
        }
        return Ok(c);
    }

    let url = format!(
        "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ru&accept-language=ru&q={}",
        percent_encode(q)
    );
    let tmp = std::env::temp_dir().join(format!("fireatlas_geocode_{}.json", std::process::id()));
    download_url_to_file(&url, &tmp).map_err(|e| {
        format!("Не удалось найти город «{q}» (нужен интернет): {e}")
    })?;
    let raw = fs::read_to_string(&tmp).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(&tmp);
    let items: Vec<NominatimHit> =
        serde_json::from_str(&raw).map_err(|e| format!("Ответ геокодера: {e}"))?;
    let hit = items
        .first()
        .ok_or_else(|| format!("Город «{q}» не найден. Проверьте написание."))?;
    let lat: f64 = hit
        .lat
        .parse()
        .map_err(|_| "Некорректные координаты города".to_string())?;
    let lon: f64 = hit
        .lon
        .parse()
        .map_err(|_| "Некорректные координаты города".to_string())?;
    let name = hit
        .display_name
        .split(',')
        .next()
        .unwrap_or(q)
        .trim()
        .to_string();
    Ok(MapCity {
        id: slugify(&name, lat, lon),
        name,
        lat,
        lon,
        zoom: if r > 20.0 { 11 } else { 12 },
        radius_km: r,
    })
}

pub fn maps_root(maps_parent: &Path) -> PathBuf {
    maps_parent.join("maps")
}

pub fn package_dir(maps_parent: &Path, city_id: &str) -> PathBuf {
    maps_root(maps_parent).join(city_id)
}

fn bbox(lat: f64, lon: f64, radius_km: f64) -> (f64, f64, f64, f64) {
    let dlat = radius_km / 111.0;
    let dlon = radius_km / (111.0 * (lat.to_radians().cos().abs().max(0.2)));
    (lat - dlat, lon - dlon, lat + dlat, lon + dlon)
}

fn lon_to_x(lon: f64, z: u32) -> u32 {
    let n = 2f64.powi(z as i32);
    (((lon + 180.0) / 360.0) * n).floor().clamp(0.0, n - 1.0) as u32
}

fn lat_to_y(lat: f64, z: u32) -> u32 {
    let n = 2f64.powi(z as i32);
    let lat_rad = lat.to_radians();
    let y = (1.0 - (lat_rad.tan() + 1.0 / lat_rad.cos()).ln() / std::f64::consts::PI) / 2.0 * n;
    y.floor().clamp(0.0, n - 1.0) as u32
}

fn collect_tiles(south: f64, west: f64, north: f64, east: f64, zmin: u32, zmax: u32) -> Vec<(u32, u32, u32)> {
    let mut out = Vec::new();
    for z in zmin..=zmax {
        let x0 = lon_to_x(west, z).min(lon_to_x(east, z));
        let x1 = lon_to_x(west, z).max(lon_to_x(east, z));
        let y0 = lat_to_y(north, z).min(lat_to_y(south, z));
        let y1 = lat_to_y(north, z).max(lat_to_y(south, z));
        for x in x0..=x1 {
            for y in y0..=y1 {
                out.push((z, x, y));
            }
        }
    }
    out
}

pub fn read_meta(dir: &Path) -> Result<MapPackageMeta, String> {
    let raw = fs::read_to_string(dir.join("meta.json")).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

pub fn list_packages(data_path: &Path) -> Result<Vec<MapPackageInfo>, String> {
    let root = maps_root(data_path);
    if !root.exists() {
        return Ok(vec![]);
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        match read_meta(&path) {
            Ok(meta) => out.push(MapPackageInfo {
                id: meta.id,
                name: meta.name,
                path: path.to_string_lossy().into_owned(),
                lat: meta.lat,
                lon: meta.lon,
                zoom: meta.zoom,
                min_zoom: meta.min_zoom,
                max_zoom: meta.max_zoom,
                tile_count: meta.tile_count,
                ready: true,
            }),
            Err(_) => {
                let id = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("?")
                    .to_string();
                out.push(MapPackageInfo {
                    id: id.clone(),
                    name: id,
                    path: path.to_string_lossy().into_owned(),
                    lat: 0.0,
                    lon: 0.0,
                    zoom: 12,
                    min_zoom: 0,
                    max_zoom: 0,
                    tile_count: 0,
                    ready: false,
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(8))
        .timeout_read(Duration::from_secs(20))
        .user_agent("FireAtlas/0.1 (offline map pack)")
        .build()
}

fn download_url_to_file(url: &str, dest: &Path) -> Result<(), String> {
    download_url_with_agent(&http_agent(), url, dest)
}

fn download_url_with_agent(agent: &ureq::Agent, url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    match agent.get(url).call() {
        Ok(resp) => {
            let mut bytes = Vec::new();
            resp.into_reader()
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            if bytes.len() < 100 {
                return Err("пустой ответ".into());
            }
            fs::write(dest, &bytes).map_err(|e| e.to_string())?;
            Ok(())
        }
        Err(_) => download_curl_hidden(url, dest),
    }
}

/// Hidden curl fallback (no console window flash on Windows).
fn download_curl_hidden(url: &str, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut cmd = std::process::Command::new("curl.exe");
    cmd.args([
        "-fsSL",
        "--connect-timeout",
        "8",
        "--max-time",
        "25",
        "-A",
        "FireAtlas/0.1",
        "-o",
        &dest.to_string_lossy(),
        url,
    ]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let status = cmd
        .status()
        .map_err(|e| format!("curl.exe не запустился: {e}"))?;
    if !status.success() {
        let _ = fs::remove_file(dest);
        return Err("curl: ошибка загрузки".into());
    }
    let len = dest.metadata().map(|m| m.len()).unwrap_or(0);
    if len < 100 {
        let _ = fs::remove_file(dest);
        return Err("пустой файл".into());
    }
    Ok(())
}

pub fn prepare_package(
    app: AppHandle,
    maps_parent: PathBuf,
    city_query: String,
    radius_km: Option<f64>,
    cancel: Arc<AtomicBool>,
) -> Result<MapPackageInfo, String> {
    let _ = app.emit(
        "map-pack-progress",
        MapPackProgress {
            city_id: String::new(),
            city_name: city_query.clone(),
            current: 0,
            total: 1,
            message: "Поиск города…".into(),
            done: false,
            error: None,
        },
    );
    let city = resolve_city_query(&city_query, radius_km)?;
    let (south, west, north, east) = bbox(city.lat, city.lon, city.radius_km);
    // z12–15: улицы видны; при зуме выше Leaflet увеличивает z15
    let zmin = 12;
    let zmax = 15;
    let tiles = collect_tiles(south, west, north, east, zmin, zmax);
    let total = tiles.len() as u32;
    if total == 0 {
        return Err("Нет тайлов для выбранной области".into());
    }
    if total > 8000 {
        return Err(format!(
            "Слишком много тайлов ({total}). Уменьшите радиус (сейчас {:.0} км).",
            city.radius_km
        ));
    }

    // Store on LOCAL disk (AppData), never on Yandex Disk / cloud data_path — otherwise writes hang.
    let dir = package_dir(&maps_parent, &city.id);
    let _ = app.emit(
        "map-pack-progress",
        MapPackProgress {
            city_id: city.id.clone(),
            city_name: city.name.clone(),
            current: 0,
            total,
            message: format!(
                "Город найден. Сохранение на локальный диск… ({})",
                dir.display()
            ),
            done: false,
            error: None,
        },
    );
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Не удалось создать папку пакета {}: {e}",
            dir.display()
        )
    })?;

    #[derive(Clone, Copy)]
    enum TileUrlKind {
        Xyz,
        Esri,
    }
    let tile_hosts: &[(&str, TileUrlKind)] = &[
        ("https://basemaps.cartocdn.com/rastertiles/voyager", TileUrlKind::Xyz),
        ("https://a.basemaps.cartocdn.com/rastertiles/voyager", TileUrlKind::Xyz),
        (
            "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile",
            TileUrlKind::Esri,
        ),
        ("https://tile.openstreetmap.org", TileUrlKind::Xyz),
    ];

    fn tile_url(host: &str, kind: TileUrlKind, z: u32, x: u32, y: u32) -> String {
        match kind {
            TileUrlKind::Xyz => format!("{host}/{z}/{x}/{y}.png"),
            TileUrlKind::Esri => format!("{host}/{z}/{y}/{x}"),
        }
    }

    // Probe (in-process HTTP, no console)
    let agent = http_agent();
    {
        let (z, x, y) = tiles[0];
        let probe = dir.join("_probe.png");
        let mut probe_ok = false;
        let mut last_err = String::from("нет ответа");
        for (host, kind) in tile_hosts {
            let url = tile_url(host, *kind, z, x, y);
            let _ = app.emit(
                "map-pack-progress",
                MapPackProgress {
                    city_id: city.id.clone(),
                    city_name: city.name.clone(),
                    current: 0,
                    total,
                    message: "Проверка доступа к тайлам…".into(),
                    done: false,
                    error: None,
                },
            );
            match download_url_with_agent(&agent, &url, &probe) {
                Ok(()) => {
                    probe_ok = true;
                    let _ = fs::remove_file(&probe);
                    break;
                }
                Err(e) => last_err = e,
            }
        }
        if !probe_ok {
            let msg = format!(
                "Не удалось скачать тайл ({last_err}). Проверьте интернет."
            );
            let _ = app.emit(
                "map-pack-progress",
                MapPackProgress {
                    city_id: city.id.clone(),
                    city_name: city.name.clone(),
                    current: 0,
                    total,
                    message: msg.clone(),
                    done: true,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    }

    let eta_min = ((total as f64) * 0.05 / 60.0).ceil().max(1.0) as u32;
    let _ = app.emit(
        "map-pack-progress",
        MapPackProgress {
            city_id: city.id.clone(),
            city_name: city.name.clone(),
            current: 0,
            total,
            message: format!("Фоновая загрузка {total} тайлов (~{eta_min} мин)…"),
            done: false,
            error: None,
        },
    );

    let mut ok = 0u32;
    let mut fail = 0u32;
    let mut consecutive_fail = 0u32;
    let mut working: Option<(String, TileUrlKind)> = None;

    for (i, (z, x, y)) in tiles.iter().enumerate() {
        if cancel.load(Ordering::Relaxed) {
            let _ = app.emit(
                "map-pack-progress",
                MapPackProgress {
                    city_id: city.id.clone(),
                    city_name: city.name.clone(),
                    current: i as u32,
                    total,
                    message: "Отменено".into(),
                    done: true,
                    error: Some("Подготовка отменена".into()),
                },
            );
            return Err("Подготовка отменена".into());
        }

        if i % 5 == 0 || i + 1 == tiles.len() {
            let _ = app.emit(
                "map-pack-progress",
                MapPackProgress {
                    city_id: city.id.clone(),
                    city_name: city.name.clone(),
                    current: (i + 1) as u32,
                    total,
                    message: format!("Скачано {ok} из {total}, ошибок {fail}"),
                    done: false,
                    error: None,
                },
            );
        }

        let tile_path = dir.join(format!("{z}/{x}/{y}.png"));
        if tile_path.exists() && tile_path.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            ok += 1;
            consecutive_fail = 0;
            continue;
        }

        let mut saved = false;
        let mut hosts_order: Vec<(String, TileUrlKind)> = Vec::new();
        if let Some(w) = working.clone() {
            hosts_order.push(w);
        }
        for (host, kind) in tile_hosts {
            if working.as_ref().map(|(h, _)| h.as_str()) != Some(*host) {
                hosts_order.push(((*host).to_string(), *kind));
            }
        }

        for (host, kind) in hosts_order {
            let url = tile_url(&host, kind, *z, *x, *y);
            if download_url_with_agent(&agent, &url, &tile_path).is_ok() {
                ok += 1;
                consecutive_fail = 0;
                working = Some((host, kind));
                saved = true;
                break;
            }
        }

        if !saved {
            fail += 1;
            consecutive_fail += 1;
        }

        if consecutive_fail >= 15 && ok == 0 {
            let msg = "Серверы тайлов недоступны. Проверьте интернет.".to_string();
            let _ = app.emit(
                "map-pack-progress",
                MapPackProgress {
                    city_id: city.id.clone(),
                    city_name: city.name.clone(),
                    current: i as u32,
                    total,
                    message: msg.clone(),
                    done: true,
                    error: Some(msg.clone()),
                },
            );
            return Err(msg);
        }
    }

    let meta = MapPackageMeta {
        id: city.id.clone(),
        name: city.name.clone(),
        lat: city.lat,
        lon: city.lon,
        zoom: city.zoom,
        min_zoom: zmin,
        max_zoom: zmax,
        south,
        west,
        north,
        east,
        tile_count: ok,
        created_at: Local::now().to_rfc3339(),
        source: "Carto Voyager / Esri / OpenStreetMap raster tiles".into(),
    };
    fs::write(
        dir.join("meta.json"),
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    let _ = app.emit(
        "map-pack-progress",
        MapPackProgress {
            city_id: city.id.clone(),
            city_name: city.name.clone(),
            current: total,
            total,
            message: format!("Готово: {ok} тайлов (ошибок {fail})"),
            done: true,
            error: if ok == 0 {
                Some("Не удалось скачать тайлы. Проверьте интернет.".into())
            } else {
                None
            },
        },
    );

    if ok == 0 {
        return Err("Не удалось скачать тайлы. Проверьте интернет.".into());
    }

    Ok(MapPackageInfo {
        id: meta.id,
        name: meta.name,
        path: dir.to_string_lossy().into_owned(),
        lat: meta.lat,
        lon: meta.lon,
        zoom: meta.zoom,
        min_zoom: meta.min_zoom,
        max_zoom: meta.max_zoom,
        tile_count: meta.tile_count,
        ready: true,
    })
}

pub fn export_package_zip(package_path: &Path, zip_path: &Path) -> Result<(), String> {
    if !package_path.join("meta.json").exists() {
        return Err("В папке нет meta.json — это не пакет карты".into());
    }
    let file = fs::File::create(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let walk = walkdir::WalkDir::new(package_path).into_iter().filter_map(|e| e.ok());
    for entry in walk {
        let path = entry.path();
        if path.is_dir() {
            continue;
        }
        let rel = path
            .strip_prefix(package_path)
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "/");
        zip.start_file(rel, opts).map_err(|e| e.to_string())?;
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        zip.write_all(&bytes).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn import_package_zip(data_path: &Path, zip_path: &Path) -> Result<MapPackageInfo, String> {
    let file = fs::File::open(zip_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let tmp = maps_root(data_path).join("_import_tmp");
    if tmp.exists() {
        let _ = fs::remove_dir_all(&tmp);
    }
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry
            .enclosed_name()
            .ok_or_else(|| "Некорректный путь в ZIP".to_string())?
            .to_path_buf();
        let out = tmp.join(&name);
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut outfile = fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut outfile).map_err(|e| e.to_string())?;
    }

    // meta may be at root of tmp or one level down
    let meta_dir = if tmp.join("meta.json").exists() {
        tmp.clone()
    } else {
        fs::read_dir(&tmp)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.is_dir() && p.join("meta.json").exists())
            .ok_or_else(|| "В архиве нет meta.json".to_string())?
    };

    let meta = read_meta(&meta_dir)?;
    let dest = package_dir(data_path, &meta.id);
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|e| e.to_string())?;
    }
    fs::create_dir_all(maps_root(data_path)).map_err(|e| e.to_string())?;
    if let Err(_e) = fs::rename(&meta_dir, &dest) {
        copy_dir_recursive(&meta_dir, &dest)?;
        let _ = fs::remove_dir_all(&meta_dir);
    }
    let _ = fs::remove_dir_all(&tmp);

    Ok(MapPackageInfo {
        id: meta.id,
        name: meta.name,
        path: dest.to_string_lossy().into_owned(),
        lat: meta.lat,
        lon: meta.lon,
        zoom: meta.zoom,
        min_zoom: meta.min_zoom,
        max_zoom: meta.max_zoom,
        tile_count: meta.tile_count,
        ready: true,
    })
}

fn copy_dir_recursive(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in walkdir::WalkDir::new(from).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        let rel = path.strip_prefix(from).map_err(|e| e.to_string())?;
        let dest = to.join(rel);
        if path.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
        } else {
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            fs::copy(path, &dest).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
