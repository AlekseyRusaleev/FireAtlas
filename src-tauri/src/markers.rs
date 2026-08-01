use crate::UserMarkerDto;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zip::write::SimpleFileOptions;

const MANAGED_BEGIN: &str = "<!-- FIREATLAS USER MARKERS BEGIN -->";
const MANAGED_END: &str = "<!-- FIREATLAS USER MARKERS END -->";

/// Резервная копия меток рядом с базой (быстрая). Основная запись — в рабочий KML/KMZ карты.
pub const MARKERS_FILE: &str = "user_markers.kml";

/// Одна запись за раз — без фоновых гонок (удаление больше не «воскрешает» метки).
static KMZ_WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn is_markers_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(MARKERS_FILE))
        .unwrap_or(false)
}

pub fn markers_file_path(data_path: &str) -> Option<PathBuf> {
    let root = data_path.trim();
    if root.is_empty() {
        return None;
    }
    Some(PathBuf::from(root).join(MARKERS_FILE))
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
        .ok_or_else(|| "В файле не найден </Document> или </kml>".to_string())?;
    base.insert_str(insert_at, &managed_folder(markers));
    Ok(base)
}

fn empty_kml_shell() -> String {
    r#"<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Пользовательские метки FireAtlas</name>
  </Document>
</kml>
"#
    .to_string()
}

/// Быстрый sidecar рядом с базой.
pub fn write_markers_file(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("создать папку меток: {e}"))?;
    }
    let original = if path.exists() {
        let bytes = fs::read(path).map_err(|e| format!("прочитать {}: {e}", path.display()))?;
        String::from_utf8(bytes).unwrap_or_else(|_| empty_kml_shell())
    } else {
        empty_kml_shell()
    };
    let updated = update_kml_text(&original, markers)?;
    let tmp = path.with_extension("kml.tmp");
    fs::write(&tmp, &updated).map_err(|e| format!("записать временный файл: {e}"))?;
    if fs::rename(&tmp, path).is_err() {
        fs::copy(&tmp, path).map_err(|e| format!("обновить {}: {e}", path.display()))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

/// Запись в рабочий KML/KMZ карты (гидранты и т.п.). Синхронно — иначе удаление откатывается.
pub fn write_markers_to_source(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let _guard = match KMZ_WRITE_LOCK.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "kml" => update_kml_file(path, markers),
        "kmz" => update_kmz_file_fast(path, markers),
        _ => Err("Рабочий файл меток должен иметь расширение .kml или .kmz".into()),
    }
}

fn update_kml_file(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|e| format!("прочитать {}: {e}", path.display()))?;
    let original = String::from_utf8(bytes)
        .map_err(|_| "Рабочий KML должен быть в кодировке UTF-8".to_string())?;
    let updated = update_kml_text(&original, markers)?;
    let tmp = path.with_extension("kml.tmp");
    fs::write(&tmp, &updated).map_err(|e| format!("записать временный: {e}"))?;
    if fs::rename(&tmp, path).is_err() {
        fs::copy(&tmp, path).map_err(|e| format!("обновить {}: {e}", path.display()))?;
        let _ = fs::remove_file(&tmp);
    }
    Ok(())
}

/// Быстрый KMZ: остальные файлы копируются сжатыми как есть (`raw_copy_file`),
/// переписывается только doc.kml — без полной перепаковки гидрантов.
fn update_kmz_file_fast(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let temp = path.with_extension("fireatlas.tmp.kmz");
    // Архив должен быть закрыт до rename/copy поверх исходного файла (иначе Windows держит lock).
    {
        let input =
            fs::File::open(path).map_err(|e| format!("открыть {}: {e}", path.display()))?;
        let mut archive = zip::ZipArchive::new(input).map_err(|e| format!("открыть KMZ: {e}"))?;

        let mut kml_index: Option<usize> = None;
        for i in 0..archive.len() {
            let entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let lower = entry.name().to_lowercase();
            if lower.ends_with("doc.kml") {
                kml_index = Some(i);
                break;
            }
            if lower.ends_with(".kml") && kml_index.is_none() {
                kml_index = Some(i);
            }
        }
        let kml_index = kml_index.ok_or_else(|| "KMZ не содержит KML".to_string())?;

        let (kml_name, original_kml) = {
            let mut entry = archive.by_index(kml_index).map_err(|e| e.to_string())?;
            let name = entry.name().to_string();
            let mut data = String::new();
            entry
                .read_to_string(&mut data)
                .map_err(|e| format!("прочитать KML из KMZ: {e}"))?;
            (name, data)
        };
        let updated_kml = update_kml_text(&original_kml, markers)?;

        let output =
            fs::File::create(&temp).map_err(|e| format!("создать временный KMZ: {e}"))?;
        let mut writer = zip::ZipWriter::new(output);
        let len = archive.len();
        for i in 0..len {
            if i == kml_index {
                let options = SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated);
                writer
                    .start_file(&kml_name, options)
                    .map_err(|e| e.to_string())?;
                writer
                    .write_all(updated_kml.as_bytes())
                    .map_err(|e| e.to_string())?;
            } else {
                let file = archive.by_index(i).map_err(|e| e.to_string())?;
                writer.raw_copy_file(file).map_err(|e| e.to_string())?;
            }
        }
        writer.finish().map_err(|e| e.to_string())?;
    }

    if fs::rename(&temp, path).is_err() {
        fs::copy(&temp, path).map_err(|e| format!("обновить {}: {e}", path.display()))?;
        let _ = fs::remove_file(&temp);
    }
    Ok(())
}

pub fn read_managed_markers(path: &Path) -> Result<Vec<ImportedMarker>, String> {
    let text = read_kml_text(path)?;
    Ok(parse_managed_placemarks(&text))
}

/// Есть ли в файле служебный блок FireAtlas (даже пустой).
pub fn has_managed_block(path: &Path) -> Result<bool, String> {
    let text = read_kml_text(path)?;
    Ok(text.contains(MANAGED_BEGIN))
}

#[derive(Debug, Clone)]
pub struct ImportedMarker {
    pub name: String,
    pub comment: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub created_at: String,
}

fn read_kml_text(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext == "kmz" {
        let input = fs::File::open(path).map_err(|e| e.to_string())?;
        let mut archive = zip::ZipArchive::new(input).map_err(|e| e.to_string())?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = entry.name().to_lowercase();
            if name.ends_with(".kml") {
                let mut data = String::new();
                entry.read_to_string(&mut data).map_err(|e| e.to_string())?;
                return Ok(data);
            }
        }
        return Err("KMZ без KML".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|_| "KML должен быть UTF-8".into())
}

fn parse_managed_placemarks(text: &str) -> Vec<ImportedMarker> {
    let Some(start) = text.find(MANAGED_BEGIN) else {
        return Vec::new();
    };
    let Some(end_rel) = text[start..].find(MANAGED_END) else {
        return Vec::new();
    };
    let block = &text[start..start + end_rel];
    let mut out = Vec::new();
    let mut rest = block;
    while let Some(pm_start) = rest.find("<Placemark") {
        let after = &rest[pm_start..];
        let Some(pm_end) = after.find("</Placemark>") else {
            break;
        };
        let pm = &after[..pm_end + "</Placemark>".len()];
        rest = &after[pm_end + "</Placemark>".len()..];

        let name = xml_tag_text(pm, "name").unwrap_or_else(|| "Метка".into());
        let comment = xml_tag_text(pm, "description");
        let created_at =
            xml_tag_text(pm, "when").unwrap_or_else(|| chrono::Local::now().to_rfc3339());
        let Some(coords) = xml_tag_text(pm, "coordinates") else {
            continue;
        };
        let parts: Vec<&str> = coords.trim().split(',').collect();
        if parts.len() < 2 {
            continue;
        }
        let Ok(lon) = parts[0].trim().parse::<f64>() else {
            continue;
        };
        let Ok(lat) = parts[1].trim().parse::<f64>() else {
            continue;
        };
        out.push(ImportedMarker {
            name,
            comment,
            lat,
            lon,
            created_at,
        });
    }
    out
}

fn xml_tag_text(hay: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = hay.find(&open)? + open.len();
    let end = hay[start..].find(&close)? + start;
    Some(unescape_xml(hay[start..end].trim()))
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
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
