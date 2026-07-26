export type WaterType = "hydrant" | "pond" | "tower" | "pier" | "other";

export type MapProviderId = "yandex" | "dgis" | "osm";

export type TabId = "map" | "cards" | "settings";

export interface AppSettings {
  data_path: string;
  map_provider: MapProviderId;
  yandex_api_key: string;
  dgis_api_key: string;
  default_city: string;
  default_lat: number;
  default_lon: number;
  default_zoom: number;
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
  kind: "water" | "card";
  title: string;
  subtitle: string;
  water_type?: WaterType | null;
  address?: string | null;
  lat?: number | null;
  lon?: number | null;
  distance_m?: number | null;
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

/** Russian cities for default map center */
export const CITIES: { name: string; lat: number; lon: number; zoom: number }[] = [
  { name: "Кемерово", lat: 55.3549, lon: 86.0885, zoom: 12 },
  { name: "Новокузнецк", lat: 53.7596, lon: 87.1216, zoom: 12 },
  { name: "Томск", lat: 56.4846, lon: 84.9476, zoom: 12 },
  { name: "Барнаул", lat: 53.3468, lon: 83.7768, zoom: 12 },
  { name: "Москва", lat: 55.7558, lon: 37.6173, zoom: 11 },
  { name: "Санкт-Петербург", lat: 59.9343, lon: 30.3351, zoom: 11 },
  { name: "Новосибирск", lat: 55.0084, lon: 82.9357, zoom: 11 },
  { name: "Екатеринбург", lat: 56.8389, lon: 60.6057, zoom: 11 },
  { name: "Казань", lat: 55.7961, lon: 49.1064, zoom: 12 },
  { name: "Нижний Новгород", lat: 56.2965, lon: 43.9361, zoom: 12 },
  { name: "Челябинск", lat: 55.1644, lon: 61.4368, zoom: 11 },
  { name: "Самара", lat: 53.1959, lon: 50.1002, zoom: 12 },
  { name: "Омск", lat: 54.9885, lon: 73.3242, zoom: 11 },
  { name: "Ростов-на-Дону", lat: 47.2357, lon: 39.7015, zoom: 12 },
  { name: "Уфа", lat: 54.7388, lon: 55.9721, zoom: 12 },
  { name: "Красноярск", lat: 56.0153, lon: 92.8932, zoom: 11 },
  { name: "Воронеж", lat: 51.672, lon: 39.1843, zoom: 12 },
  { name: "Пермь", lat: 58.0105, lon: 56.2502, zoom: 12 },
  { name: "Волгоград", lat: 48.708, lon: 44.5133, zoom: 12 },
  { name: "Краснодар", lat: 45.0355, lon: 38.9753, zoom: 12 },
  { name: "Тюмень", lat: 57.1522, lon: 65.5272, zoom: 12 },
  { name: "Иркутск", lat: 52.2869, lon: 104.305, zoom: 12 },
  { name: "Хабаровск", lat: 48.4827, lon: 135.0838, zoom: 12 },
  { name: "Владивосток", lat: 43.1155, lon: 131.8855, zoom: 12 },
];
