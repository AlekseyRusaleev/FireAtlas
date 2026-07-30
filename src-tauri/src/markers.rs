use crate::UserMarkerDto;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

const MANAGED_BEGIN: &str = "<!-- FIREATLAS USER MARKERS BEGIN -->";
const MANAGED_END: &str = "<!-- FIREATLAS USER MARKERS END -->";

/// Метки пользователя дублируются в этот файл рядом с базой, чтобы их можно было
/// открыть в Google Earth / Яндекс.Картах без приложения.
pub const MARKERS_FILE: &str = "user_markers.kml";

/// Совпадает ли имя файла с экспортом меток: индексатор такие файлы пропускает,
/// иначе метки попадут в индекс ИППВ при переиндексации.
pub fn is_markers_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(MARKERS_FILE))
        .unwrap_or(false)
}

fn managed_folder(markers: &[UserMarkerDto]) -> String {
    let mut xml = String::with_capacity(256 + markers.len() * 320);
    xml.push_str(&format!("\n    {MANAGED_BEGIN}\n"));
    xml.push_str("    <Folder><name>Пользовательские метки FireAtlas</name>\n");
    for m in markers {
        xml.push_str(&format!("      <Placemark id=\"fireatlas-user-{}\">\n", m.id));
        xml.push_str(&format!("        <name>{}</name>\n", escape_xml(&m.name)));
        if let Some(comment) = m.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            xml.push_str(&format!(
                "        <description>{}</description>\n",
                escape_xml(comment)
            ));
        }
        xml.push_str(&format!(
            "        <TimeStamp><when>{}</when></TimeStamp>\n",
            escape_xml(&m.created_at)
        ));
        xml.push_str(&format!(
            "        <Point><coordinates>{:.6},{:.6},0</coordinates></Point>\n",
            m.lon, m.lat
        ));
        xml.push_str("      </Placemark>\n");
    }
    xml.push_str("    </Folder>\n");
    xml.push_str(&format!("    {MANAGED_END}\n"));
    xml
}

fn update_kml_text(original: &str, markers: &[UserMarkerDto]) -> Result<String, String> {
    let mut base = original.to_string();
    if let Some(start) = base.find(MANAGED_BEGIN) {
        let end = base[start..]
            .find(MANAGED_END)
            .map(|offset| start + offset + MANAGED_END.len())
            .ok_or_else(|| "Повреждён служебный блок меток FireAtlas".to_string())?;
        base.replace_range(start..end, "");
    }
    let insert_at = base
        .rfind("</Document>")
        .or_else(|| base.rfind("</kml>"))
        .ok_or_else(|| "В рабочем файле не найден закрывающий тег </Document> или </kml>".to_string())?;
    base.insert_str(insert_at, &managed_folder(markers));
    Ok(base)
}

fn ensure_backup(path: &Path) -> Result<(), String> {
    let backup = PathBuf::from(format!("{}.bak", path.display()));
    if !backup.exists() {
        fs::copy(path, &backup).map_err(|e| {
            format!(
                "не удалось создать резервную копию {}: {e}",
                backup.display()
            )
        })?;
    }
    Ok(())
}

fn update_kml_file(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("прочитать {}: {e}", path.display()))?;
    let original = String::from_utf8(bytes)
        .map_err(|_| "Рабочий KML должен быть в кодировке UTF-8".to_string())?;
    let updated = update_kml_text(&original, markers)?;
    ensure_backup(path)?;
    fs::write(path, updated).map_err(|e| format!("записать {}: {e}", path.display()))
}

fn update_kmz_file(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let input = fs::File::open(path).map_err(|e| format!("открыть {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(input).map_err(|e| format!("открыть KMZ: {e}"))?;
    let mut entries: Vec<(String, bool, zip::CompressionMethod, Vec<u8>)> = Vec::new();
    let mut kml_name: Option<String> = None;

    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = entry.name().to_string();
        let is_dir = entry.is_dir();
        let compression = entry.compression();
        let mut data = Vec::new();
        if !is_dir {
            entry.read_to_end(&mut data).map_err(|e| e.to_string())?;
        }
        let lower = name.to_lowercase();
        if lower.ends_with("doc.kml") || (lower.ends_with(".kml") && kml_name.is_none()) {
            kml_name = Some(name.clone());
        }
        entries.push((name, is_dir, compression, data));
    }
    drop(archive);

    let kml_name = kml_name.ok_or_else(|| "KMZ не содержит KML".to_string())?;
    let temp = path.with_extension("fireatlas.tmp.kmz");
    let output = fs::File::create(&temp).map_err(|e| format!("создать временный KMZ: {e}"))?;
    let mut writer = zip::ZipWriter::new(output);
    for (name, is_dir, compression, data) in entries {
        let options = SimpleFileOptions::default().compression_method(compression);
        if is_dir {
            writer.add_directory(name, options).map_err(|e| e.to_string())?;
            continue;
        }
        writer.start_file(&name, options).map_err(|e| e.to_string())?;
        if name == kml_name {
            let original = String::from_utf8(data)
                .map_err(|_| "KML внутри KMZ должен быть в кодировке UTF-8".to_string())?;
            writer
                .write_all(update_kml_text(&original, markers)?.as_bytes())
                .map_err(|e| e.to_string())?;
        } else {
            writer.write_all(&data).map_err(|e| e.to_string())?;
        }
    }
    writer.finish().map_err(|e| e.to_string())?;
    ensure_backup(path)?;
    fs::copy(&temp, path).map_err(|e| format!("обновить {}: {e}", path.display()))?;
    let _ = fs::remove_file(temp);
    Ok(())
}

pub fn write_markers_to_source(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "kml" => update_kml_file(path, markers),
        "kmz" => update_kmz_file(path, markers),
        _ => Err("Рабочий файл меток должен иметь расширение .kml или .kmz".into()),
    }
}

fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(ch),
        }
    }
    out
}
