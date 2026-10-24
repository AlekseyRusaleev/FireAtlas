export type WaterType = "hydrant" | "pond" | "tower" | "pier" | "other";

export type MapProviderId = "yandex" | "dgis" | "osm" | "local";

export type TabId = "map" | "cards" | "settings" | "about";

export interface AppSettings {
  data_path: string;
  map_provider: MapProviderId;
  yandex_api_key: string;
  dgis_api_key: string;
  default_city: string;
  default_lat: number;
  default_lon: number;
  default_zoom: number;
  local_map_city_id: string;
  local_map_path: string;
  infocard_api_base: string;
  infocard_enabled: boolean;
  infocard_login: string;
  /** local | server | both */
  cards_mode: string;
  /** local | server — водоисточники на карте */
  markers_mode: string;
  /** Радиус скачивания локальной карты, км (5–35) */
  map_radius_km: number;
}

export interface IndexStats {
  water_points: number;
  cards: number;
  sources: number;
  last_indexed_at: string | null;
}

export interface ReindexReport {
  water_points: number;
  cards: number;
  sources: number;
  files_found: number;
  files_ok: number;
  files_failed: number;
  points_parsed: number;
  scanned_dirs: string[];
  errors: string[];
  last_indexed_at: string | null;
  hint: string;
}

export interface SearchHit {
  id: number;
  kind: "water" | "card" | "infocard";
  title: string;
  subtitle: string;
  water_type?: WaterType | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  distance_m?: number | null;
  /** ID файла на сервере Infocard (когда kind === "infocard"). */
  infocard_id?: string | null;
  infocard_status?: string | null;
  /** Папка карточки на Infocard (для списка текст/графика). */
  infocard_folder_id?: string | null;
  infocard_folder_name?: string | null;
}

export interface WaterPoint {
  id: number;
  name: string;
  water_type: WaterType;
  lat: number;
  lon: number;
  address: string | null;
  description: string | null;
  source_path: string | null;
}

export interface CardFile {
  id: number;
  kind: "word" | "visio" | "jpg" | "pdf" | "other";
  path: string;
  name: string;
}

export interface Card {
  id: number;
  title: string;
  address: string | null;
  district: string | null;
  number: string | null;
  lat: number | null;
  lon: number | null;
  folder_path: string;
  files: CardFile[];
}

export interface SourceInfo {
  id: number;
  path: string;
  kind: string;
  mtime: number;
  status: string;
  point_count: number;
  file_name: string;
}

export interface NearbyPoint {
  id: number;
  name: string;
  water_type: WaterType;
  lat: number;
  lon: number;
  distance_m: number;
}

export interface UserMarker {
  id: number;
  name: string;
  comment: string | null;
  lat: number;
  lon: number;
  created_at: string;
  /** Present when loaded from Infocard API */
  server_id?: string | null;
}

export interface MarkerFileInfo {
  path: string;
  count: number;
}

export interface MarkersState {
  markers: UserMarker[];
  /** null, если путь к базе не задан — метки хранятся только в приложении. */
  file: MarkerFileInfo | null;
  /** Метки сохранены в базе, но выгрузить KML не удалось (например, сеть недоступна). */
  file_error: string | null;
}

export const WATER_TYPE_SHORT: Record<WaterType, string> = {
  hydrant: "Гидрант",
  pond: "Водоём",
  tower: "Башня",
  pier: "Пирс",
  other: "Объект",
};

/** Города для выбора центра карты. Сначала пункты ФПС НСО. */
export const CITIES: { name: string; lat: number; lon: number; zoom: number }[] = [
  { name: "Новосибирск", lat: 55.0084, lon: 82.9357, zoom: 11 },
  { name: "Бердск", lat: 54.7586, lon: 83.0967, zoom: 13 },
  { name: "Искитим", lat: 54.6397, lon: 83.3061, zoom: 13 },
  { name: "Куйбышев", lat: 55.4475, lon: 78.3219, zoom: 13 },
  { name: "Краснообск", lat: 54.9203, lon: 82.9906, zoom: 14 },
  { name: "Карасук", lat: 53.7178, lon: 78.04, zoom: 13 },
  { name: "Мошково", lat: 55.305, lon: 83.6086, zoom: 14 },
  { name: "Кемерово", lat: 55.3549, lon: 86.0885, zoom: 12 },
  { name: "Новокузнецк", lat: 53.7596, lon: 87.1216, zoom: 12 },
  { name: "Томск", lat: 56.4846, lon: 84.9476, zoom: 12 },
  { name: "Барнаул", lat: 53.3468, lon: 83.7768, zoom: 12 },
  { name: "Омск", lat: 54.9885, lon: 73.3242, zoom: 11 },
  { name: "Красноярск", lat: 56.0153, lon: 92.8932, zoom: 11 },
  { name: "Москва", lat: 55.7558, lon: 37.6173, zoom: 11 },
  { name: "Санкт-Петербург", lat: 59.9343, lon: 30.3351, zoom: 11 },
];

/** ID вшитых пакетов карт ФПС НСО (рядом с EXE в maps/). */
export const BUNDLED_NSO_MAP_IDS = [
  "novosibirsk",
  "berdsk",
  "iskitim",
  "kuybyshev",
  "krasnoobsk",
  "karasuk",
  "moshkovo",
] as const;

export interface MapCity {
  id: string;
  name: string;
  lat: number;
  lon: number;
  zoom: number;
  radius_km: number;
}

export interface MapPackageInfo {
  id: string;
  name: string;
  path: string;
  lat: number;
  lon: number;
  zoom: number;
  min_zoom: number;
  max_zoom: number;
  tile_count: number;
  ready: boolean;
  /** Радиус покрытия пакета, км (если известен) */
  radius_km?: number;
}

export interface MapPackProgress {
  city_id: string;
  city_name: string;
  current: number;
  total: number;
  message: string;
  done: boolean;
  error: string | null;
}