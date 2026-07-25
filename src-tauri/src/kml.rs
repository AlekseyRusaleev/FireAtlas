use crate::WaterType;
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::Cursor;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct KmlPlacemark {
    pub name: String,
    pub description: Option<String>,
    pub address: Option<String>,
    pub lat: f64,
    pub lon: f64,
    pub water_type: WaterType,
    pub external_id: Option<String>,
}

pub fn parse_kml_bytes(bytes: &[u8]) -> Result<Vec<KmlPlacemark>, String> {
    let mut reader = Reader::from_reader(Cursor::new(bytes));
    reader.config_mut().trim_text(true);

    let mut buf = Vec::new();
    let mut placemarks = Vec::new();

    let mut in_placemark = false;
    let mut in_name = false;
    let mut in_description = false;
    let mut in_address = false;
    let mut in_coordinates = false;
    let mut in_folder_name = false;

    let mut name = String::new();
    let mut description = String::new();
    let mut address = String::new();
    let mut coordinates = String::new();
    let mut folder_hint = String::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_lowercase();
                match local.as_str() {
                    "placemark" => {
                        in_placemark = true;
                        name.clear();
                        description.clear();
                        address.clear();
                        coordinates.clear();
                    }
                    "name" if in_placemark => in_name = true,
                    "name" if !in_placemark => in_folder_name = true,
                    "description" if in_placemark => in_description = true,
                    "address" if in_placemark => in_address = true,
                    "coordinates" if in_placemark => in_coordinates = true,
                    _ => {}
                }
            }
            Ok(Event::Empty(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_lowercase();
                if local == "coordinates" && in_placemark {
                    // sometimes empty
                }
            }
            Ok(Event::Text(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                if in_name {
                    name.push_str(&text);
                } else if in_description {
                    description.push_str(&text);
                } else if in_address {
                    address.push_str(&text);
                } else if in_coordinates {
                    coordinates.push_str(&text);
                } else if in_folder_name {
                    folder_hint = text;
                }
            }
            Ok(Event::CData(t)) => {
                let text = String::from_utf8_lossy(t.as_ref()).into_owned();
                if in_description {
                    description.push_str(&text);
                } else if in_name {
                    name.push_str(&text);
                }
            }
            Ok(Event::End(e)) => {
                let tag = String::from_utf8_lossy(e.name().as_ref()).to_string();
                let local = tag.split(':').last().unwrap_or(&tag).to_lowercase();
                match local.as_str() {
                    "name" => {
                        in_name = false;
                        in_folder_name = false;
                    }
                    "description" => in_description = false,
                    "address" => in_address = false,
                    "coordinates" => in_coordinates = false,
                    "placemark" => {
                        in_placemark = false;
                        if let Some((lon, lat)) = parse_first_coordinate(&coordinates) {
                            let hint = format!("{name} {description} {folder_hint}");
                            placemarks.push(KmlPlacemark {
                                name: if name.trim().is_empty() {
                                    format!("Точка {lat:.5},{lon:.5}")
                                } else {
                                    name.trim().to_string()
                                },
                                description: non_empty(description.trim()),
                                address: non_empty(address.trim()),
                                lat,
                                lon,
                                water_type: WaterType::from_str_loose(&hint),
                                external_id: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("KML parse error: {e}")),
            _ => {}
        }
        buf.clear();
    }

    Ok(placemarks)
}

pub fn parse_kml_file(path: &Path) -> Result<Vec<KmlPlacemark>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("read {}: {e}", path.display()))?;
    parse_kml_bytes(&bytes)
}

pub fn parse_kmz_file(path: &Path) -> Result<Vec<KmlPlacemark>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("kmz zip: {e}"))?;

    // Prefer doc.kml, else first .kml
    let mut kml_index: Option<usize> = None;
    for i in 0..archive.len() {
        let name = archive
            .by_index(i)
            .map_err(|e| e.to_string())?
            .name()
            .to_string();
        let lower = name.to_lowercase();
        if lower.ends_with("doc.kml") {
            kml_index = Some(i);
            break;
        }
        if lower.ends_with(".kml") && kml_index.is_none() {
            kml_index = Some(i);
        }
    }

    let idx = kml_index.ok_or_else(|| "KMZ не содержит KML".to_string())?;
    let mut entry = archive.by_index(idx).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    std::io::Read::read_to_end(&mut entry, &mut bytes).map_err(|e| e.to_string())?;
    parse_kml_bytes(&bytes)
}

fn parse_first_coordinate(raw: &str) -> Option<(f64, f64)> {
    // KML standard: lon,lat[,alt]
    for token in raw.split_whitespace() {
        let mut parts = token.split(',');
        let lon: f64 = match parts.next()?.trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        let lat: f64 = match parts.next()?.trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if (-180.0..=180.0).contains(&lon) && (-90.0..=90.0).contains(&lat) {
            return Some((lon, lat));
        }
    }
    None
}

fn non_empty(s: &str) -> Option<String> {
    if s.is_empty() {
        None
    } else {
        Some(s.to_string())
    }
}
