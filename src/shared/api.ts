import { invoke } from "@tauri-apps/api/core";
import type {
  AppSettings,
  Card,
  IndexStats,
  MapCity,
  MapPackageInfo,
  MarkersState,
  NearbyPoint,
  ReindexReport,
  SearchHit,
  SourceInfo,
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

export async function reindex(): Promise<ReindexReport> {
  return invoke("reindex");
}

export async function importKmzFiles(): Promise<ReindexReport> {
  return invoke("import_kmz_files");
}

export async function importKmzFolder(): Promise<ReindexReport> {
  return invoke("import_kmz_folder");
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

export async function deleteWaterPoint(id: number): Promise<void> {
  return invoke("delete_water_point", { id });
}

export async function moveWaterPoint(
  id: number,
  lat: number,
  lon: number
): Promise<WaterPoint> {
  return invoke("move_water_point", { id, lat, lon });
}

export async function getCard(id: number): Promise<Card | null> {
  return invoke("get_card", { id });
}

export async function listCards(query: string, limit = 2000): Promise<Card[]> {
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

export async function listSources(): Promise<SourceInfo[]> {
  return invoke("list_sources");
}

export async function deleteSource(id: number): Promise<SourceInfo[]> {
  return invoke("delete_source", { id });
}

export async function listMarkers(): Promise<MarkersState> {
  return invoke("list_markers");
}

export async function infocardListMarkers(): Promise<MarkersState> {
  return invoke("infocard_list_markers");
}

export async function addMarker(
  name: string,
  comment: string | null,
  lat: number,
  lon: number,
  sourcePath?: string | null
): Promise<MarkersState> {
  return invoke("add_marker", { name, comment, lat, lon, sourcePath: sourcePath ?? null });
}

export async function updateMarker(
  id: number,
  name: string,
  comment: string | null,
  lat: number,
  lon: number
): Promise<MarkersState> {
  return invoke("update_marker", { id, name, comment, lat, lon });
}

export async function deleteMarker(id: number): Promise<MarkersState> {
  return invoke("delete_marker", { id });
}

export async function openPath(path: string): Promise<void> {
  return invoke("open_path", { path });
}

export async function openFolder(path: string): Promise<void> {
  return invoke("open_folder", { path });
}

export async function readFileBase64(path: string): Promise<string> {
  return invoke("read_file_base64", { path });
}

export async function pickDataFolder(): Promise<string | null> {
  return invoke("pick_data_folder");
}

export async function listMapCities(): Promise<MapCity[]> {
  return invoke("list_map_cities");
}

export async function resolveCity(
  query: string,
  radiusKm?: number
): Promise<MapCity> {
  return invoke("resolve_city", { query, radiusKm: radiusKm ?? null });
}

export async function listMapPackages(): Promise<MapPackageInfo[]> {
  return invoke("list_map_packages");
}

export async function prepareMapPackage(
  cityName: string,
  radiusKm?: number
): Promise<void> {
  return invoke("prepare_map_package", {
    cityName,
    radiusKm: radiusKm ?? null,
  });
}

export async function cancelMapPackage(): Promise<void> {
  return invoke("cancel_map_package");
}

export async function importMapPackageZip(): Promise<MapPackageInfo> {
  return invoke("import_map_package_zip");
}

export async function exportMapPackageZip(packagePath?: string): Promise<string> {
  return invoke("export_map_package_zip", { packagePath: packagePath ?? null });
}

export async function pickMapPackageFolder(): Promise<MapPackageInfo> {
  return invoke("pick_map_package_folder");
}

export interface InfocardSession {
  access_token: string;
  refresh_token?: string;
  login: string;
}

export interface InfocardFileHit {
  id: string;
  name: string;
  status?: string | null;
  kind?: string | null;
  folder_id?: string | null;
  folder_name?: string | null;
  has_pdf?: boolean | null;
}

export async function infocardGetSession(): Promise<InfocardSession> {
  return invoke("infocard_get_session");
}

export async function infocardLogin(
  login: string,
  password: string
): Promise<InfocardSession> {
  return invoke("infocard_login", { login, password });
}

export async function infocardLogout(): Promise<void> {
  return invoke("infocard_logout");
}

export async function infocardSearchFiles(
  query: string,
  limit = 100
): Promise<InfocardFileHit[]> {
  return invoke("infocard_search_files", { query, limit });
}

export async function infocardListFolderFiles(
  folderId: string
): Promise<InfocardFileHit[]> {
  return invoke("infocard_list_folder_files", { folderId });
}

export async function infocardGetFile(fileId: string): Promise<InfocardFileHit> {
  return invoke("infocard_get_file", { fileId });
}

export async function infocardOpenPdf(fileId: string): Promise<string> {
  /** Скачивает PDF в кэш и возвращает локальный путь (без внешнего открытия). */
  return invoke("infocard_open_pdf", { fileId });
}

export interface PortableArtifact {
  url: string;
  sha256: string;
}

export interface UpdateManifest {
  version: string;
  notes: string;
  publishedAt: string;
  portable: PortableArtifact;
}

export interface UpdateCheckResult {
  currentVersion: string;
  updateAvailable: boolean;
  latest: UpdateManifest | null;
}

export async function getAppVersion(): Promise<string> {
  return invoke("get_app_version");
}

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  return invoke("check_for_updates");
}

export async function downloadAndApplyUpdate(url: string, sha256: string): Promise<void> {
  return invoke("download_and_apply_update", { url, sha256 });
}

