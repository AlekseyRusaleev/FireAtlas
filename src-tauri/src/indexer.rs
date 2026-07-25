use crate::db::Db;
use crate::kml;
use chrono::Local;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Default)]
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

pub fn reindex_all(db: &mut Db, root: PathBuf) -> Result<ReindexReport, String> {
    if !root.exists() {
        return Err(format!("Папка не найдена: {}", root.display()));
    }

    let mut report = ReindexReport::default();
    index_water_sources(db, &root, &mut report)?;
    index_cards(db, &root, &mut report)?;

    let now = Local::now().to_rfc3339();
    db.set_meta("last_indexed_at", &now)?;
    let stats = db.stats()?;
    report.water_points = stats.water_points;
    report.cards = stats.cards;
    report.sources = stats.sources;
    report.last_indexed_at = Some(now);

    if report.files_found == 0 {
        report.hint = format!(
            "В «{}» не найдено .kml/.kmz. Положите файлы в папку KMZ внутри базы или нажмите «Импорт KML/KMZ».",
            root.display()
        );
    } else if report.points_parsed == 0 {
        report.hint = "Файлы найдены, но точки не извлечены. Возможно, нестандартный KML — пришлите пример файла.".into();
    } else {
        report.hint = format!(
            "Индексация завершена: файлов {}, точек {}, ошибок {}.",
            report.files_ok, report.points_parsed, report.files_failed
        );
    }

    Ok(report)
}

fn collect_map_files(root: &Path, report: &mut ReindexReport) -> Vec<PathBuf> {
    let named = [
        "KMZ",
        "kmz",
        "Maps",
        "maps",
        "WaterSources",
        "Водоисточники",
        "водоисточники",
        "Гидранты",
        "гидранты",
        "KML",
        "kml",
    ];

    let mut files: Vec<PathBuf> = Vec::new();

    for name in named {
        let dir = root.join(name);
        if !dir.is_dir() {
            continue;
        }
        report.scanned_dirs.push(dir.display().to_string());
        collect_under(&dir, 8, &mut files);
    }

    // Shallow scan of the data root itself (depth <= 3) — catches arbitrary layouts safely.
    report
        .scanned_dirs
        .push(format!("{} (глубина ≤3)", root.display()));
    for entry in WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if is_map_file(path) {
            files.push(path.to_path_buf());
        }
    }

    files.sort();
    files.dedup();
    files
}

fn collect_under(dir: &Path, max_depth: usize, out: &mut Vec<PathBuf>) {
    for entry in WalkDir::new(dir)
        .max_depth(max_depth)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if path.is_file() && is_map_file(path) {
            out.push(path.to_path_buf());
        }
    }
}

fn is_map_file(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase()
            .as_str(),
        "kml" | "kmz"
    )
}

fn index_water_sources(db: &mut Db, root: &Path, report: &mut ReindexReport) -> Result<(), String> {
    let files = collect_map_files(root, report);
    report.files_found = files.len();

    for path in files {
        match index_one_map_file(db, &path) {
            Ok(n) => {
                report.files_ok += 1;
                report.points_parsed += n;
            }
            Err(e) => {
                report.files_failed += 1;
                if report.errors.len() < 15 {
                    report
                        .errors
                        .push(format!("{}: {e}", path.display()));
                }
            }
        }
    }
    Ok(())
}

/// Returns number of placemarks inserted.
pub fn index_one_map_file(db: &mut Db, path: &Path) -> Result<usize, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    let hash = hex::encode(Sha256::digest(&bytes));
    let path_str = path.to_string_lossy().to_string();
    let kind = if path_str.to_lowercase().ends_with(".kmz") {
        "kmz"
    } else {
        "kml"
    };

    // Folder name hint improves type detection (e.g. .../Гидранты/file.kmz)
    let path_hint = path
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    let source_id = db.upsert_source(&path_str, kind, mtime, &hash)?;
    db.clear_source_points(source_id)?;

    let mut placemarks = if kind == "kmz" {
        kml::parse_kmz_file(path)?
    } else {
        kml::parse_kml_file(path)?
    };

    for pm in &mut placemarks {
        if matches!(pm.water_type, crate::WaterType::Other) {
            pm.water_type = crate::WaterType::from_str_loose(&path_hint);
        }
    }

    let count = placemarks.len();
    for pm in placemarks {
        db.insert_water_point(
            source_id,
            &pm.name,
            pm.water_type.as_str(),
            pm.lat,
            pm.lon,
            pm.address.as_deref(),
            pm.description.as_deref(),
            pm.external_id.as_deref(),
        )?;
    }
    Ok(count)
}

fn index_cards(db: &mut Db, root: &Path, report: &mut ReindexReport) -> Result<(), String> {
    let candidates = [
        root.join("KTP"),
        root.join("ktp"),
        root.join("КТП"),
        root.join("Cards"),
        root.join("cards"),
        root.join("Карточки"),
        root.join("Информационные карточки"),
        root.join("информационные карточки"),
        root.join("ИК"),
    ];

    let mut dirs: Vec<PathBuf> = candidates.into_iter().filter(|d| d.is_dir()).collect();

    // If the data root itself looks like a cards folder (children named "ИК …"), index it.
    if looks_like_cards_root(root) {
        dirs.push(root.to_path_buf());
    }

    dirs.sort();
    dirs.dedup();

    for dir in dirs {
        report.scanned_dirs.push(dir.display().to_string());
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                if let Err(e) = index_card_folder(db, &path) {
                    if report.errors.len() < 15 {
                        report
                            .errors
                            .push(format!("карточка {}: {e}", path.display()));
                    }
                }
            }
        }
    }
    Ok(())
}

fn looks_like_cards_root(root: &Path) -> bool {
    let Ok(entries) = fs::read_dir(root) else {
        return false;
    };
    let mut ik = 0usize;
    for entry in entries.flatten().take(30) {
        let name = entry.file_name().to_string_lossy().to_uppercase();
        if entry.path().is_dir() && (name.starts_with("ИК") || name.starts_with("IK")) {
            ik += 1;
        }
    }
    ik >= 3
}

pub fn import_map_files(db: &mut Db, data_root: &Path, files: &[PathBuf]) -> Result<usize, String> {
    if !data_root.exists() {
        return Err(format!("Папка базы не найдена: {}", data_root.display()));
    }
    let dest_dir = data_root.join("KMZ");
    fs::create_dir_all(&dest_dir).map_err(|e| format!("создать KMZ: {e}"))?;

    let mut imported = 0usize;
    let mut errors = Vec::new();
    for src in files {
        if !src.is_file() || !is_map_file(src) {
            continue;
        }
        let name = src
            .file_name()
            .ok_or_else(|| "некорректное имя файла".to_string())?;
        let dest = dest_dir.join(name);
        fs::copy(src, &dest).map_err(|e| format!("копирование {}: {e}", src.display()))?;
        match index_one_map_file(db, &dest) {
            Ok(_) => imported += 1,
            Err(e) => errors.push(format!("{}: {e}", dest.display())),
        }
    }

    let now = Local::now().to_rfc3339();
    db.set_meta("last_indexed_at", &now)?;
    if imported == 0 {
        if errors.is_empty() {
            return Err("Не выбрано ни одного .kml/.kmz файла".into());
        }
        return Err(errors.join("; "));
    }
    Ok(imported)
}

fn index_card_folder(db: &mut Db, folder: &Path) -> Result<(), String> {
    let title = folder
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Без названия")
        .to_string();

    let meta = fs::metadata(folder).map_err(|e| e.to_string())?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut body = title.clone();

    for entry in WalkDir::new(folder)
        .max_depth(2)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let kind = match ext.as_str() {
            "doc" | "docx" | "rtf" => "word",
            "vsd" | "vsdx" => "visio",
            "jpg" | "jpeg" | "png" | "webp" | "bmp" => "jpg",
            "pdf" => "pdf",
            _ => continue,
        };
        body.push(' ');
        body.push_str(&name);
        if ext == "docx" {
            if let Ok(text) = extract_docx_text(path) {
                body.push(' ');
                body.push_str(&text);
            }
        }
        files.push((kind.into(), path.to_path_buf()));
    }

    if files.is_empty() {
        return Ok(());
    }

    let parsed = parse_card_title(&title);
    let folder_str = folder.to_string_lossy().to_string();
    let card_id = db.upsert_card(
        &parsed.title,
        parsed.address.as_deref(),
        parsed.district.as_deref(),
        parsed.number.as_deref(),
        &folder_str,
        mtime,
        &body,
    )?;

    for (kind, path) in files {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        db.insert_card_file(card_id, &kind, &path.to_string_lossy(), &name)?;
    }
    Ok(())
}

fn extract_number(title: &str) -> Option<String> {
    // Prefer "ИК №12" / "№12" style numbers
    let upper = title.replace('№', "№");
    if let Some(pos) = upper.find('№') {
        let tail: String = upper[pos + '№'.len_utf8()..]
            .chars()
            .skip_while(|c| c.is_whitespace())
            .take_while(|c| c.is_ascii_digit())
            .collect();
        if !tail.is_empty() {
            return Some(tail);
        }
    }
    let digits: String = title.chars().filter(|c| c.is_ascii_digit()).take(4).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

struct ParsedCardTitle {
    title: String,
    number: Option<String>,
    address: Option<String>,
    district: Option<String>,
}

fn parse_card_title(raw: &str) -> ParsedCardTitle {
    let number = extract_number(raw);
    // Heuristic: address often after last comma or after closing «...»
    let address = {
        let mut addr = None;
        if let Some(idx) = raw.rfind(',') {
            let tail = raw[idx + 1..].trim();
            if tail.len() > 3 {
                addr = Some(tail.to_string());
            }
        }
        if addr.is_none() {
            if let Some(idx) = raw.rfind('»') {
                let tail = raw[idx + '»'.len_utf8()..].trim().trim_start_matches(',').trim();
                if tail.len() > 3 {
                    addr = Some(tail.to_string());
                }
            }
        }
        addr
    };

    ParsedCardTitle {
        title: raw.to_string(),
        number,
        address,
        district: None,
    }
}

fn extract_docx_text(path: &Path) -> Result<String, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut file = archive
        .by_name("word/document.xml")
        .map_err(|e| e.to_string())?;
    let mut xml = String::new();
    std::io::Read::read_to_string(&mut file, &mut xml).map_err(|e| e.to_string())?;

    let mut out = String::new();
    let mut in_tag = false;
    for ch in xml.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    Ok(out
        .split_whitespace()
        .take(4000)
        .collect::<Vec<_>>()
        .join(" "))
}
