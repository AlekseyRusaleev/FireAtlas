use std::path::PathBuf;

use crate::db::Db;
use crate::kml;
use chrono::Local;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::SystemTime;
use walkdir::WalkDir;

pub fn reindex_all(db: &mut Db, root: PathBuf) -> Result<(), String> {
    if !root.exists() {
        return Err(format!("Папка не найдена: {}", root.display()));
    }

    index_water_sources(db, &root)?;
    index_cards(db, &root)?;

    let now = Local::now().to_rfc3339();
    db.set_meta("last_indexed_at", &now)?;
    Ok(())
}

fn index_water_sources(db: &mut Db, root: &Path) -> Result<(), String> {
    let candidates = [
        root.join("KMZ"),
        root.join("kmz"),
        root.join("Maps"),
        root.join("maps"),
        root.join("WaterSources"),
        root.to_path_buf(),
    ];

    let mut files: Vec<PathBuf> = Vec::new();
    for dir in candidates {
        if !dir.exists() {
            continue;
        }
        for entry in WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if ext == "kml" || ext == "kmz" {
                files.push(path.to_path_buf());
            }
        }
    }

    files.sort();
    files.dedup();

    for path in files {
        index_one_map_file(db, &path)?;
    }
    Ok(())
}

fn index_one_map_file(db: &mut Db, path: &Path) -> Result<(), String> {
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

    let source_id = db.upsert_source(&path_str, kind, mtime, &hash)?;
    db.clear_source_points(source_id)?;

    let placemarks = if kind == "kmz" {
        kml::parse_kmz_file(path)?
    } else {
        kml::parse_kml_file(path)?
    };

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
    Ok(())
}

fn index_cards(db: &mut Db, root: &Path) -> Result<(), String> {
    let candidates = [
        root.join("KTP"),
        root.join("ktp"),
        root.join("Cards"),
        root.join("cards"),
        root.join("Карточки"),
    ];

    for dir in candidates {
        if !dir.exists() {
            continue;
        }
        for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.is_dir() {
                index_card_folder(db, &path)?;
            }
        }
    }
    Ok(())
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

    let number = extract_number(&title);
    let folder_str = folder.to_string_lossy().to_string();
    let card_id = db.upsert_card(
        &title,
        None,
        None,
        number.as_deref(),
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
    let digits: String = title.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
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
