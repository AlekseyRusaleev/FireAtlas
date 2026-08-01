//! Удаление и перенос Placemark ИППВ в рабочем KML/KMZ (вне блока меток FireAtlas).

use std::fs;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::Mutex;
use zip::write::SimpleFileOptions;

const MANAGED_BEGIN: &str = "<!-- FIREATLAS USER MARKERS BEGIN -->";
const MANAGED_END: &str = "<!-- FIREATLAS USER MARKERS END -->";

static SOURCE_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Максимальное расстояние (м) для сопоставления точки с Placemark в файле.
const MATCH_RADIUS_M: f64 = 80.0;

pub fn delete_placemark_in_source(
    path: &Path,
    name: &str,
    lat: f64,
    lon: f64,
) -> Result<(), String> {
    transform_source_kml(path, |text| {
        let (start, end) = find_best_placemark(text, name, lat, lon)?;
        let mut out = text.to_string();
        out.replace_range(start..end, "");
        // Убрать лишние пустые строки после вырезания
        Ok(out)
    })
}

pub fn move_placemark_in_source(
    path: &Path,
    name: &str,
    old_lat: f64,
    old_lon: f64,
    new_lat: f64,
    new_lon: f64,
) -> Result<(), String> {
    if !new_lat.is_finite() || !new_lon.is_finite() {
        return Err("Некорректные координаты".into());
    }
    transform_source_kml(path, |text| {
        let (start, end) = find_best_placemark(text, name, old_lat, old_lon)?;
        let pm = &text[start..end];
        let Some((c_start, c_end, alt)) = find_coordinates_span(pm) else {
            return Err("У точки нет координат в KML".into());
        };
        let new_coords = format!("{new_lon:.6},{new_lat:.6},{alt}");
        let mut out = text.to_string();
        let abs_start = start + c_start;
        let abs_end = start + c_end;
        out.replace_range(abs_start..abs_end, &new_coords);
        Ok(out)
    })
}

fn transform_source_kml(
    path: &Path,
    f: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let _guard = match SOURCE_WRITE_LOCK.lock() {
        Ok(g) => g,
        Err(e) => e.into_inner(),
    };
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "kml" => {
            let bytes = fs::read(path).map_err(|e| format!("прочитать {}: {e}", path.display()))?;
            let original = decode_kml_bytes(&bytes);
            let updated = f(&original)?;
            let tmp = path.with_extension("wateredit.tmp.kml");
            fs::write(&tmp, updated.as_bytes()).map_err(|e| format!("записать временный: {e}"))?;
            replace_file(&tmp, path)?;
            Ok(())
        }
        "kmz" => rewrite_kmz_kml(path, f),
        _ => Err("Файл ИППВ должен быть .kml или .kmz".into()),
    }
}

fn replace_file(tmp: &Path, path: &Path) -> Result<(), String> {
    if fs::rename(tmp, path).is_err() {
        fs::copy(tmp, path).map_err(|e| format!("обновить {}: {e}", path.display()))?;
        let _ = fs::remove_file(tmp);
    }
    Ok(())
}

fn decode_kml_bytes(bytes: &[u8]) -> String {
    let bytes = bytes
        .strip_prefix(&[0xEF, 0xBB, 0xBF])
        .unwrap_or(bytes);
    match String::from_utf8(bytes.to_vec()) {
        Ok(s) => s,
        Err(_) => {
            // Типичные российские KMZ в Windows-1251 — приближённо через lossy UTF-8
            // недостаточно; декодируем байты как latin1-совместимо и оставляем кириллицу
            // через Windows-1251 вручную для диапазона 0xC0-0xFF.
            decode_windows1251(bytes)
        }
    }
}

fn decode_windows1251(bytes: &[u8]) -> String {
    // Таблица CP1251 для 0x80..=0xFF (упрощённо — основные русские буквы).
    const MAP: [char; 128] = [
        '\u{0402}', '\u{0403}', '\u{201A}', '\u{0453}', '\u{201E}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{20AC}', '\u{2030}', '\u{0409}', '\u{2039}', '\u{040A}', '\u{040C}',
        '\u{040B}', '\u{040F}', '\u{0452}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{FFFD}', '\u{2122}', '\u{0459}', '\u{203A}',
        '\u{045A}', '\u{045C}', '\u{045B}', '\u{045F}', '\u{00A0}', '\u{040E}', '\u{045E}',
        '\u{0408}', '\u{00A4}', '\u{0490}', '\u{00A6}', '\u{00A7}', '\u{0401}', '\u{00A9}',
        '\u{0404}', '\u{00AB}', '\u{00AC}', '\u{00AD}', '\u{00AE}', '\u{0407}', '\u{00B0}',
        '\u{00B1}', '\u{0406}', '\u{0456}', '\u{0491}', '\u{00B5}', '\u{00B6}', '\u{00B7}',
        '\u{0451}', '\u{2116}', '\u{0454}', '\u{00BB}', '\u{0458}', '\u{0405}', '\u{0455}',
        '\u{0457}', '\u{0410}', '\u{0411}', '\u{0412}', '\u{0413}', '\u{0414}', '\u{0415}',
        '\u{0416}', '\u{0417}', '\u{0418}', '\u{0419}', '\u{041A}', '\u{041B}', '\u{041C}',
        '\u{041D}', '\u{041E}', '\u{041F}', '\u{0420}', '\u{0421}', '\u{0422}', '\u{0423}',
        '\u{0424}', '\u{0425}', '\u{0426}', '\u{0427}', '\u{0428}', '\u{0429}', '\u{042A}',
        '\u{042B}', '\u{042C}', '\u{042D}', '\u{042E}', '\u{042F}', '\u{0430}', '\u{0431}',
        '\u{0432}', '\u{0433}', '\u{0434}', '\u{0435}', '\u{0436}', '\u{0437}', '\u{0438}',
        '\u{0439}', '\u{043A}', '\u{043B}', '\u{043C}', '\u{043D}', '\u{043E}', '\u{043F}',
        '\u{0440}', '\u{0441}', '\u{0442}', '\u{0443}', '\u{0444}', '\u{0445}', '\u{0446}',
        '\u{0447}', '\u{0448}', '\u{0449}', '\u{044A}', '\u{044B}', '\u{044C}', '\u{044D}',
        '\u{044E}', '\u{044F}',
    ];
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if b < 0x80 {
            out.push(b as char);
        } else {
            out.push(MAP[(b - 0x80) as usize]);
        }
    }
    out
}

fn rewrite_kmz_kml(
    path: &Path,
    f: impl FnOnce(&str) -> Result<String, String>,
) -> Result<(), String> {
    let temp = path.with_extension("wateredit.tmp.kmz");
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
            let mut data = Vec::new();
            entry
                .read_to_end(&mut data)
                .map_err(|e| format!("прочитать KML из KMZ: {e}"))?;
            (name, decode_kml_bytes(&data))
        };
        let updated_kml = f(&original_kml)?;

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

    replace_file(&temp, path)
}

fn managed_ranges(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut from = 0usize;
    while let Some(rel) = text[from..].find(MANAGED_BEGIN) {
        let start = from + rel;
        let end = text[start..]
            .find(MANAGED_END)
            .map(|o| start + o + MANAGED_END.len())
            .unwrap_or(text.len());
        out.push((start, end));
        from = end;
    }
    out
}

fn in_managed(pos: usize, ranges: &[(usize, usize)]) -> bool {
    ranges.iter().any(|&(a, b)| pos >= a && pos < b)
}

fn find_best_placemark(
    text: &str,
    name: &str,
    lat: f64,
    lon: f64,
) -> Result<(usize, usize), String> {
    let managed = managed_ranges(text);
    let name_n = normalize_name(name);
    let name_is_generated = name_n.starts_with("точка ");

    let mut best_coord: Option<(usize, usize, f64, bool)> = None;

    let mut rest = text;
    let mut offset = 0usize;
    while let Some(rel) = rest.find("<Placemark") {
        let abs = offset + rel;
        let after = &text[abs..];
        // Закрывающий тег с возможным namespace: </Placemark> или </kml:Placemark>
        let Some(end_mark) = after.find("</Placemark>") else {
            // namespace close tag
            let lower_after = after.to_lowercase();
            let Some(ns) = lower_after.find("placemark>") else {
                break;
            };
            // must be part of </...placemark>
            if !lower_after[..ns].contains("</") {
                break;
            }
            let end = abs + ns + "placemark>".len();
            offset = end;
            rest = &text[end..];
            // skip managed processing by continuing with this end — fall through by restructure
            // Actually handle in loop body below is hard; require </Placemark>
            continue;
        };
        let end = abs + end_mark + "</Placemark>".len();
        offset = end;
        rest = &text[end..];

        if in_managed(abs, &managed) {
            continue;
        }
        let pm = &text[abs..end];
        if pm.contains("fireatlas-user-") {
            continue;
        }

        let Some((plat, plon)) = coords_from_placemark(pm) else {
            continue;
        };
        let dist_m = haversine_m(lat, lon, plat, plon);
        if dist_m > MATCH_RADIUS_M {
            continue;
        }

        let pm_name = first_placemark_name(pm);
        let name_match = !name_is_generated
            && !name_n.is_empty()
            && normalize_name(&pm_name) == name_n;

        match best_coord {
            None => best_coord = Some((abs, end, dist_m, name_match)),
            Some((_, _, d, nm)) => {
                // Предпочитаем совпадение имени; при равенстве — ближе по координатам
                let better = (name_match && !nm)
                    || (name_match == nm && dist_m < d)
                    || (!name_match && !nm && dist_m < d);
                if better {
                    best_coord = Some((abs, end, dist_m, name_match));
                }
            }
        }
    }

    best_coord
        .map(|(a, b, _, _)| (a, b))
        .ok_or_else(|| {
            format!(
                "Точка «{name}» ({lat:.5},{lon:.5}) не найдена в файле карты в радиусе {MATCH_RADIUS_M:.0} м"
            )
        })
}

fn first_placemark_name(pm: &str) -> String {
    // Ищем первый <name>…</name> внутри placemark (не вложенных глубоко в StyleMap обычно ок)
    xml_tag_text_ci(pm, "name").unwrap_or_default()
}

fn coords_from_placemark(pm: &str) -> Option<(f64, f64)> {
    let coords = xml_tag_text_ci(pm, "coordinates")?;
    parse_lon_lat(&coords)
}

fn parse_lon_lat(raw: &str) -> Option<(f64, f64)> {
    for token in raw.split_whitespace() {
        let mut parts = token.split(',');
        let lon: f64 = parts.next()?.trim().parse().ok()?;
        let lat: f64 = parts.next()?.trim().parse().ok()?;
        if (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat) {
            return Some((lat, lon));
        }
    }
    // fallback: одна строка lon,lat[,alt] с переносами
    let compact: String = raw
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let mut parts = compact.split(',');
    let lon: f64 = parts.next()?.parse().ok()?;
    let lat: f64 = parts.next()?.parse().ok()?;
    if (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat) {
        Some((lat, lon))
    } else {
        None
    }
}

fn find_coordinates_span(pm: &str) -> Option<(usize, usize, String)> {
    let lower = pm.to_lowercase();
    let open_key = "<coordinates";
    let open_at = lower.find(open_key)?;
    let after_open = open_at + open_key.len();
    let gt = pm[after_open..].find('>')? + after_open + 1;
    let close_key = "</coordinates>";
    let close_rel = lower[gt..].find(close_key)?;
    let end = gt + close_rel;
    let start = gt;
    let raw = pm[start..end].trim();
    let alt = {
        let parts: Vec<&str> = raw.split(',').collect();
        if parts.len() >= 3 {
            parts[2].trim().to_string()
        } else {
            "0".into()
        }
    };
    let trim_start = pm[start..end]
        .find(|c: char| !c.is_whitespace())
        .map(|i| start + i)
        .unwrap_or(start);
    let trim_end = pm[start..end]
        .rfind(|c: char| !c.is_whitespace())
        .map(|i| start + i + 1)
        .unwrap_or(end);
    Some((trim_start, trim_end, alt))
}

fn xml_tag_text_ci(hay: &str, tag: &str) -> Option<String> {
    let lower = hay.to_lowercase();
    let open_pat = format!("<{tag}");
    let close_pat = format!("</{tag}>");
    let mut from = 0usize;
    while let Some(rel) = lower[from..].find(&open_pat) {
        let open_at = from + rel;
        let after = open_at + open_pat.len();
        let next = *hay.as_bytes().get(after)?;
        // не матчить <namespace> / <namedSomething>
        if !(next == b'>' || next == b' ' || next == b'\t' || next == b'\n' || next == b'\r' || next == b'/')
        {
            from = after;
            continue;
        }
        let gt = hay[after..].find('>')? + after;
        if hay.as_bytes().get(gt.saturating_sub(1)) == Some(&b'/') {
            from = gt + 1;
            continue;
        }
        let content_start = gt + 1;
        let close_rel = lower[content_start..].find(&close_pat)?;
        let content_end = content_start + close_rel;
        let raw = hay[content_start..content_end].trim();
        let text = if raw.starts_with("<![CDATA[") && raw.ends_with("]]>") {
            &raw[9..raw.len() - 3]
        } else {
            raw
        };
        return Some(unescape_xml(text.trim()));
    }
    None
}

fn unescape_xml(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

fn normalize_name(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase()
}

fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    const R: f64 = 6371000.0;
    let to_rad = |d: f64| d.to_radians();
    let dlat = to_rad(lat2 - lat1);
    let dlon = to_rad(lon2 - lon1);
    let a = (dlat / 2.0).sin().powi(2)
        + to_rad(lat1).cos() * to_rad(lat2).cos() * (dlon / 2.0).sin().powi(2);
    2.0 * R * a.sqrt().asin()
}
