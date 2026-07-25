export type WaterType = "hydrant" | "pond" | "tower" | "pier" | "other";

export type MapProviderId = "yandex" | "dgis" | "osm";

export type TabId = "map" | "cards" | "settings";

export interface AppSettings {
  data_path: string;
  map_provider: MapProviderId;
  yandex_api_key: string;
  dgis_api_key: string;
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

export interface NearbyPoint {
  id: number;
  name: string;
  water_type: WaterType;
  lat: number;
  lon: number;
  distance_m: number;
}

export const WATER_TYPE_LABELS: Record<WaterType, string> = {
  hydrant: "Гидранты",
  pond: "Водоёмы",
  tower: "Башни",
  pier: "Пирсы",
  other: "Прочее",
};

export const WATER_TYPE_SHORT: Record<WaterType, string> = {
  hydrant: "Гидрант",
  pond: "Водоём",
  tower: "Башня",
  pier: "Пирс",
  other: "Объект",
};
