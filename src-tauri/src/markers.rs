use crate::UserMarkerDto;
use std::path::{Path, PathBuf};

/// Метки пользователя дублируются в этот файл рядом с базой, чтобы их можно было
/// открыть в Google Earth / Яндекс.Картах без приложения.
pub const MARKERS_FILE: &str = "user_markers.kml";

pub fn markers_file_path(data_path: &str) -> Option<PathBuf> {
    let trimmed = data_path.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(Path::new(trimmed).join(MARKERS_FILE))
}

/// Совпадает ли имя файла с экспортом меток: индексатор такие файлы пропускает,
/// иначе метки попадут в индекс ИППВ при переиндексации.
pub fn is_markers_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.eq_ignore_ascii_case(MARKERS_FILE))
        .unwrap_or(false)
}

pub fn write_markers_kml(path: &Path, markers: &[UserMarkerDto]) -> Result<(), String> {
    let mut xml = String::with_capacity(512 + markers.len() * 256);
    xml.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    xml.push_str("<kml xmlns=\"http://www.opengis.net/kml/2.2\">\n");
    xml.push_str("  <Document>\n");
    xml.push_str("    <name>Метки Пожарного Атласа</name>\n");

    for m in markers {
        xml.push_str("    <Placemark>\n");
        xml.push_str(&format!("      <name>{}</name>\n", escape_xml(&m.name)));
        if let Some(comment) = m.comment.as_deref().filter(|c| !c.trim().is_empty()) {
            xml.push_str(&format!(
                "      <description>{}</description>\n",
                escape_xml(comment)
            ));
        }
        xml.push_str(&format!(
            "      <TimeStamp><when>{}</when></TimeStamp>\n",
            escape_xml(&m.created_at)
        ));
        xml.push_str(&format!(
            "      <Point><coordinates>{:.6},{:.6},0</coordinates></Point>\n",
            m.lon, m.lat
        ));
        xml.push_str("    </Placemark>\n");
    }

    xml.push_str("  </Document>\n");
    xml.push_str("</kml>\n");

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("не удалось создать папку для меток: {e}"))?;
    }
    std::fs::write(path, xml).map_err(|e| format!("не удалось записать {}: {e}", path.display()))
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
