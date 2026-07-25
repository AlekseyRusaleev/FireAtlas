import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  Card,
  IndexStats,
  NearbyPoint,
  SearchHit,
  WaterPoint,
  WaterType,
} from "./types";

export async function getSettings(): Promise<AppSettings> {
  return invoke("get_settings");
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  return invoke("save_settings", { settings });
}

export async function getStats(): Promise<IndexStats> {
  return invoke("get_stats");
}

export async function reindex(): Promise<IndexStats> {
  return invoke("reindex");
}

export async function search(
  query: string,
  types: WaterType[],
  limit = 50
): Promise<SearchHit[]> {
  return invoke("search", { query, types, limit });
}

export async function getWaterInBounds(
  minLat: number,
  minLon: number,
  maxLat: number,
  maxLon: number,
  types: WaterType[]
): Promise<WaterPoint[]> {
  return invoke("get_water_in_bounds", {
    minLat,
    minLon,
    maxLat,
    maxLon,
    types,
  });
}

export async function getWaterPoint(id: number): Promise<WaterPoint | null> {
  return invoke("get_water_point", { id });
}

export async function getCard(id: number): Promise<Card | null> {
  return invoke("get_card", { id });
}

export async function listCards(query: string, limit = 100): Promise<Card[]> {
  return invoke("list_cards", { query, limit });
}

export async function nearby(
  lat: number,
  lon: number,
  limit = 10,
  types: WaterType[] = ["hydrant", "pond", "tower", "pier"]
): Promise<NearbyPoint[]> {
  return invoke("nearby", { lat, lon, limit, types });
}

export async function addHistory(kind: string, id: number, title: string): Promise<void> {
  return invoke("add_history", { kind, id, title });
}

export async function getHistory(limit = 20): Promise<SearchHit[]> {
  return invoke("get_history", { limit });
}

export async function toggleFavorite(kind: string, id: number, title: string): Promise<boolean> {
  return invoke("toggle_favorite", { kind, id, title });
}

export async function getFavorites(): Promise<SearchHit[]> {
  return invoke("get_favorites");
}

export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path });
}

export async function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export async function pickDataFolder(): Promise<string | null> {
  return invoke("pick_data_folder");
}
