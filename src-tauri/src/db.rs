use crate::{CardDto, CardFileDto, IndexStats, NearbyPoint, SearchHit, WaterPointDto};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

pub struct Db {
    conn: Connection,
}

impl Db {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, String> {
        let conn = Connection::open(path.as_ref()).map_err(|e| e.to_string())?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(|e| e.to_string())?;
        let db = Self { conn };
        db.migrate()?;
        Ok(db)
    }

    fn migrate(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
                CREATE TABLE IF NOT EXISTS meta (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS sources (
                  id INTEGER PRIMARY KEY,
                  path TEXT NOT NULL UNIQUE,
                  kind TEXT NOT NULL,
                  mtime INTEGER NOT NULL,
                  hash TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'ok'
                );

                CREATE TABLE IF NOT EXISTS water_points (
                  id INTEGER PRIMARY KEY,
                  source_id INTEGER REFERENCES sources(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  water_type TEXT NOT NULL,
                  lat REAL NOT NULL,
                  lon REAL NOT NULL,
                  address TEXT,
                  description TEXT,
                  external_id TEXT
                );

                CREATE INDEX IF NOT EXISTS idx_water_bounds ON water_points(lat, lon);
                CREATE INDEX IF NOT EXISTS idx_water_type ON water_points(water_type);

                CREATE TABLE IF NOT EXISTS cards (
                  id INTEGER PRIMARY KEY,
                  title TEXT NOT NULL,
                  address TEXT,
                  district TEXT,
                  number TEXT,
                  lat REAL,
                  lon REAL,
                  folder_path TEXT NOT NULL UNIQUE,
                  mtime INTEGER NOT NULL
                );

                CREATE TABLE IF NOT EXISTS card_files (
                  id INTEGER PRIMARY KEY,
                  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
                  kind TEXT NOT NULL,
                  path TEXT NOT NULL UNIQUE,
                  name TEXT NOT NULL
                );

                CREATE TABLE IF NOT EXISTS favorites (
                  id INTEGER PRIMARY KEY,
                  kind TEXT NOT NULL,
                  ref_id INTEGER NOT NULL,
                  title TEXT NOT NULL,
                  UNIQUE(kind, ref_id)
                );

                CREATE TABLE IF NOT EXISTS history (
                  id INTEGER PRIMARY KEY,
                  kind TEXT NOT NULL,
                  ref_id INTEGER NOT NULL,
                  title TEXT NOT NULL,
                  opened_at TEXT NOT NULL
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS water_points_fts USING fts5(
                  name, address, description, water_type,
                  content='water_points', content_rowid='id'
                );

                CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
                  title, address, district, number, body,
                  content='', content_rowid='id'
                );
                "#,
            )
            .map_err(|e| e.to_string())
    }

    pub fn conn(&mut self) -> &mut Connection {
        &mut self.conn
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO meta(key,value) VALUES(?1,?2)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![key, value],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row(
                "SELECT value FROM meta WHERE key=?1",
                params![key],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn stats(&self) -> Result<IndexStats, String> {
        let water_points: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM water_points", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let cards: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM cards", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let sources: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM sources", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        Ok(IndexStats {
            water_points,
            cards,
            sources,
            last_indexed_at: self.get_meta("last_indexed_at")?,
        })
    }

    pub fn clear_source_points(&self, source_id: i64) -> Result<(), String> {
        // Remove FTS rows for points of this source
        self.conn
            .execute(
                "DELETE FROM water_points_fts WHERE rowid IN (SELECT id FROM water_points WHERE source_id=?1)",
                params![source_id],
            )
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "DELETE FROM water_points WHERE source_id=?1",
                params![source_id],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn upsert_source(
        &self,
        path: &str,
        kind: &str,
        mtime: i64,
        hash: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO sources(path, kind, mtime, hash, status) VALUES(?1,?2,?3,?4,'ok')
                 ON CONFLICT(path) DO UPDATE SET kind=excluded.kind, mtime=excluded.mtime, hash=excluded.hash, status='ok'",
                params![path, kind, mtime, hash],
            )
            .map_err(|e| e.to_string())?;
        let id: i64 = self
            .conn
            .query_row("SELECT id FROM sources WHERE path=?1", params![path], |r| {
                r.get(0)
            })
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn insert_water_point(
        &self,
        source_id: i64,
        name: &str,
        water_type: &str,
        lat: f64,
        lon: f64,
        address: Option<&str>,
        description: Option<&str>,
        external_id: Option<&str>,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO water_points(source_id, name, water_type, lat, lon, address, description, external_id)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![
                    source_id,
                    name,
                    water_type,
                    lat,
                    lon,
                    address,
                    description,
                    external_id
                ],
            )
            .map_err(|e| e.to_string())?;
        let id = self.conn.last_insert_rowid();
        self.conn
            .execute(
                "INSERT INTO water_points_fts(rowid, name, address, description, water_type)
                 VALUES(?1,?2,?3,?4,?5)",
                params![id, name, address.unwrap_or(""), description.unwrap_or(""), water_type],
            )
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn upsert_card(
        &self,
        title: &str,
        address: Option<&str>,
        district: Option<&str>,
        number: Option<&str>,
        folder_path: &str,
        mtime: i64,
        body: &str,
    ) -> Result<i64, String> {
        self.conn
            .execute(
                "INSERT INTO cards(title, address, district, number, folder_path, mtime)
                 VALUES(?1,?2,?3,?4,?5,?6)
                 ON CONFLICT(folder_path) DO UPDATE SET
                   title=excluded.title,
                   address=excluded.address,
                   district=excluded.district,
                   number=excluded.number,
                   mtime=excluded.mtime",
                params![title, address, district, number, folder_path, mtime],
            )
            .map_err(|e| e.to_string())?;
        let id: i64 = self
            .conn
            .query_row(
                "SELECT id FROM cards WHERE folder_path=?1",
                params![folder_path],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;

        self.conn
            .execute("DELETE FROM cards_fts WHERE rowid=?1", params![id])
            .map_err(|e| e.to_string())?;
        self.conn
            .execute(
                "INSERT INTO cards_fts(rowid, title, address, district, number, body)
                 VALUES(?1,?2,?3,?4,?5,?6)",
                params![
                    id,
                    title,
                    address.unwrap_or(""),
                    district.unwrap_or(""),
                    number.unwrap_or(""),
                    body
                ],
            )
            .map_err(|e| e.to_string())?;

        self.conn
            .execute("DELETE FROM card_files WHERE card_id=?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn insert_card_file(
        &self,
        card_id: i64,
        kind: &str,
        path: &str,
        name: &str,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT OR REPLACE INTO card_files(card_id, kind, path, name) VALUES(?1,?2,?3,?4)",
                params![card_id, kind, path, name],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    fn fts_query(raw: &str) -> String {
        raw.split_whitespace()
            .filter(|t| !t.is_empty())
            .map(|t| {
                let safe: String = t
                    .chars()
                    .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
                    .collect();
                if safe.is_empty() {
                    String::new()
                } else {
                    format!("{safe}*")
                }
            })
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>()
            .join(" ")
    }

    pub fn search(
        &self,
        query: &str,
        types: &[String],
        limit: i64,
    ) -> Result<Vec<SearchHit>, String> {
        let q = query.trim();
        if q.is_empty() {
            return Ok(vec![]);
        }
        let fts = Self::fts_query(q);
        if fts.is_empty() {
            return Ok(vec![]);
        }

        let mut hits = Vec::new();

        let type_filter = if types.is_empty() {
            None
        } else {
            Some(types.to_vec())
        };

        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT w.id, w.name, w.water_type, w.address, w.lat, w.lon
                     FROM water_points_fts
                     JOIN water_points w ON w.id = water_points_fts.rowid
                     WHERE water_points_fts MATCH ?1
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;

            let rows = stmt
                .query_map(params![fts, limit], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, f64>(4)?,
                        r.get::<_, f64>(5)?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            for row in rows {
                let (id, name, water_type, address, lat, lon) = row.map_err(|e| e.to_string())?;
                if let Some(ref allowed) = type_filter {
                    if !allowed.iter().any(|t| t == &water_type) {
                        continue;
                    }
                }
                hits.push(SearchHit {
                    id,
                    kind: "water".into(),
                    title: name,
                    subtitle: address
                        .clone()
                        .unwrap_or_else(|| format!("{lat:.5}, {lon:.5}")),
                    water_type: Some(water_type),
                    address,
                    lat: Some(lat),
                    lon: Some(lon),
                    distance_m: None,
                });
            }
        }

        {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT c.id, c.title, c.address, c.district, c.number, c.lat, c.lon
                     FROM cards_fts
                     JOIN cards c ON c.id = cards_fts.rowid
                     WHERE cards_fts MATCH ?1
                     LIMIT ?2",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![fts, limit], |r| {
                    Ok((
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, Option<String>>(3)?,
                        r.get::<_, Option<String>>(4)?,
                        r.get::<_, Option<f64>>(5)?,
                        r.get::<_, Option<f64>>(6)?,
                    ))
                })
                .map_err(|e| e.to_string())?;

            for row in rows {
                let (id, title, address, district, number, lat, lon) =
                    row.map_err(|e| e.to_string())?;
                let subtitle = [number, address.clone(), district]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" · ");
                hits.push(SearchHit {
                    id,
                    kind: "card".into(),
                    title,
                    subtitle: if subtitle.is_empty() {
                        "Карточка тушения".into()
                    } else {
                        subtitle
                    },
                    water_type: None,
                    address,
                    lat,
                    lon,
                    distance_m: None,
                });
            }
        }

        hits.truncate(limit as usize);
        Ok(hits)
    }

    pub fn water_in_bounds(
        &self,
        min_lat: f64,
        min_lon: f64,
        max_lat: f64,
        max_lon: f64,
        types: &[String],
    ) -> Result<Vec<WaterPointDto>, String> {
        let mut sql = String::from(
            "SELECT w.id, w.name, w.water_type, w.lat, w.lon, w.address, w.description, s.path
             FROM water_points w
             LEFT JOIN sources s ON s.id = w.source_id
             WHERE w.lat BETWEEN ?1 AND ?2 AND w.lon BETWEEN ?3 AND ?4",
        );
        if !types.is_empty() {
            sql.push_str(" AND w.water_type IN (");
            sql.push_str(
                &types
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", i + 5))
                    .collect::<Vec<_>>()
                    .join(","),
            );
            sql.push(')');
        }
        sql.push_str(" LIMIT 5000");

        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![
            Box::new(min_lat),
            Box::new(max_lat),
            Box::new(min_lon),
            Box::new(max_lon),
        ];
        for t in types {
            params_vec.push(Box::new(t.clone()));
        }
        let params_refs: Vec<&dyn rusqlite::ToSql> = params_vec.iter().map(|b| b.as_ref()).collect();

        let rows = stmt
            .query_map(params_refs.as_slice(), |r| {
                Ok(WaterPointDto {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    water_type: r.get(2)?,
                    lat: r.get(3)?,
                    lon: r.get(4)?,
                    address: r.get(5)?,
                    description: r.get(6)?,
                    source_path: r.get(7)?,
                })
            })
            .map_err(|e| e.to_string())?;

        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn get_water(&self, id: i64) -> Result<Option<WaterPointDto>, String> {
        self.conn
            .query_row(
                "SELECT w.id, w.name, w.water_type, w.lat, w.lon, w.address, w.description, s.path
                 FROM water_points w
                 LEFT JOIN sources s ON s.id = w.source_id
                 WHERE w.id=?1",
                params![id],
                |r| {
                    Ok(WaterPointDto {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        water_type: r.get(2)?,
                        lat: r.get(3)?,
                        lon: r.get(4)?,
                        address: r.get(5)?,
                        description: r.get(6)?,
                        source_path: r.get(7)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())
    }

    pub fn get_card(&self, id: i64) -> Result<Option<CardDto>, String> {
        let card = self
            .conn
            .query_row(
                "SELECT id, title, address, district, number, lat, lon, folder_path
                 FROM cards WHERE id=?1",
                params![id],
                |r| {
                    Ok(CardDto {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        address: r.get(2)?,
                        district: r.get(3)?,
                        number: r.get(4)?,
                        lat: r.get(5)?,
                        lon: r.get(6)?,
                        folder_path: r.get(7)?,
                        files: vec![],
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;

        let Some(mut card) = card else {
            return Ok(None);
        };

        let mut stmt = self
            .conn
            .prepare("SELECT id, kind, path, name FROM card_files WHERE card_id=?1 ORDER BY kind")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id], |r| {
                Ok(CardFileDto {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    path: r.get(2)?,
                    name: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            card.files.push(row.map_err(|e| e.to_string())?);
        }
        Ok(Some(card))
    }

    pub fn list_cards(&self, query: &str, limit: i64) -> Result<Vec<CardDto>, String> {
        let q = query.trim();
        if q.is_empty() {
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id, title, address, district, number, lat, lon, folder_path
                     FROM cards ORDER BY title LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![limit], |r| {
                    Ok(CardDto {
                        id: r.get(0)?,
                        title: r.get(1)?,
                        address: r.get(2)?,
                        district: r.get(3)?,
                        number: r.get(4)?,
                        lat: r.get(5)?,
                        lon: r.get(6)?,
                        folder_path: r.get(7)?,
                        files: vec![],
                    })
                })
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row.map_err(|e| e.to_string())?);
            }
            return Ok(out);
        }

        let fts = Self::fts_query(q);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT c.id, c.title, c.address, c.district, c.number, c.lat, c.lon, c.folder_path
                 FROM cards_fts
                 JOIN cards c ON c.id = cards_fts.rowid
                 WHERE cards_fts MATCH ?1
                 LIMIT ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![fts, limit], |r| {
                Ok(CardDto {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    address: r.get(2)?,
                    district: r.get(3)?,
                    number: r.get(4)?,
                    lat: r.get(5)?,
                    lon: r.get(6)?,
                    folder_path: r.get(7)?,
                    files: vec![],
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn nearby(
        &self,
        lat: f64,
        lon: f64,
        limit: i64,
        types: &[String],
    ) -> Result<Vec<NearbyPoint>, String> {
        // Rough degree window (~5 km)
        let d = 0.05;
        let points = self.water_in_bounds(lat - d, lon - d, lat + d, lon + d, types)?;
        let mut scored: Vec<NearbyPoint> = points
            .into_iter()
            .map(|p| {
                let dist = haversine_m(lat, lon, p.lat, p.lon);
                NearbyPoint {
                    id: p.id,
                    name: p.name,
                    water_type: p.water_type,
                    lat: p.lat,
                    lon: p.lon,
                    distance_m: dist,
                }
            })
            .collect();
        scored.sort_by(|a, b| a.distance_m.partial_cmp(&b.distance_m).unwrap());
        scored.truncate(limit as usize);
        Ok(scored)
    }

    pub fn add_history(&self, kind: &str, id: i64, title: &str) -> Result<(), String> {
        let now = chrono::Local::now().to_rfc3339();
        self.conn
            .execute(
                "INSERT INTO history(kind, ref_id, title, opened_at) VALUES(?1,?2,?3,?4)",
                params![kind, id, title, now],
            )
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_history(&self, limit: i64) -> Result<Vec<SearchHit>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT kind, ref_id, title, opened_at FROM history ORDER BY id DESC LIMIT ?1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![limit], |r| {
                Ok(SearchHit {
                    id: r.get(1)?,
                    kind: r.get(0)?,
                    title: r.get(2)?,
                    subtitle: r.get::<_, String>(3)?,
                    water_type: None,
                    address: None,
                    lat: None,
                    lon: None,
                    distance_m: None,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }

    pub fn toggle_favorite(&self, kind: &str, id: i64, title: &str) -> Result<bool, String> {
        let exists: Option<i64> = self
            .conn
            .query_row(
                "SELECT id FROM favorites WHERE kind=?1 AND ref_id=?2",
                params![kind, id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if exists.is_some() {
            self.conn
                .execute(
                    "DELETE FROM favorites WHERE kind=?1 AND ref_id=?2",
                    params![kind, id],
                )
                .map_err(|e| e.to_string())?;
            Ok(false)
        } else {
            self.conn
                .execute(
                    "INSERT INTO favorites(kind, ref_id, title) VALUES(?1,?2,?3)",
                    params![kind, id, title],
                )
                .map_err(|e| e.to_string())?;
            Ok(true)
        }
    }

    pub fn get_favorites(&self) -> Result<Vec<SearchHit>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT kind, ref_id, title FROM favorites ORDER BY title")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SearchHit {
                    id: r.get(1)?,
                    kind: r.get(0)?,
                    title: r.get(2)?,
                    subtitle: "Избранное".into(),
                    water_type: None,
                    address: None,
                    lat: None,
                    lon: None,
                    distance_m: None,
                })
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| e.to_string())?);
        }
        Ok(out)
    }
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
