import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import * as api from "../../shared/api";
import { hasReadableText, sanitizeDescription } from "../../shared/html";
import {
  WATER_TYPE_SHORT,
  type AppSettings,
  type MapPackageInfo,
  type MarkerFileInfo,
  type MarkersState,
  type NearbyPoint,
  type SearchHit,
  type UserMarker,
  type WaterPoint,
  type WaterType,
} from "../../shared/types";
import { LocalMapView } from "./LocalMapView";
import { HouseNumbersLayer } from "./HouseNumbersLayer";
import { WaterClusterLayer } from "./WaterClusterLayer";
import type { SearchPin } from "./YandexMapView";
import { PdfViewer } from "../../shared/PdfViewer";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  distanceKm,
  geocodeAddress,
  parseAddressQuery,
  suggestAddresses,
  type AddressSuggestion,
} from "./geocode";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const ALL_TYPES: WaterType[] = ["hydrant", "pond", "tower", "pier", "other"];
const ADDRESS_ZOOM = 17;
const INFOCARD_SEARCH_LIMIT = 100;

function infocardFileRole(name: string): string {
  const n = name.toLowerCase();
  if (/\.(vsd|vsdx|vss|vst)x?$/i.test(n) || /схем|графич|visio|план/i.test(n)) {
    return "Графическая часть";
  }
  if (/\.(doc|docx|rtf|odt)$/i.test(n) || /текст/i.test(n)) {
    return "Текстовая часть";
  }
  if (/\.(jpe?g|png|tif{1,2}|webp|bmp)$/i.test(n)) return "Изображение";
  if (/\.pdf$/i.test(n)) return "PDF";
  return "Файл";
}

function groupInfocardSearchHits(files: api.InfocardFileHit[]): SearchHit[] {
  type Group = {
    folderId: string;
    title: string;
    fileId: string | null;
    status: string | null;
    pathHint: string | null;
  };
  const groups = new Map<string, Group>();
  let anon = 0;

  for (const f of files) {
    const isFolder = (f.kind || "").toLowerCase() === "folder";
    if (isFolder) {
      if (!groups.has(f.id)) {
        groups.set(f.id, {
          folderId: f.id,
          title: f.name || "Карточка",
          fileId: null,
          status: null,
          pathHint: f.folder_name || null,
        });
      }
      continue;
    }
    const folderId = f.folder_id || "";
    const key = folderId || `file:${f.id}`;
    const existing = groups.get(key);
    if (!existing) {
      const fromPath = f.folder_name?.split("/").pop()?.trim();
      groups.set(key, {
        folderId,
        title: fromPath || f.name.replace(/\.[^.]+$/, "") || `Карточка ${++anon}`,
        fileId: f.id,
        status: f.status || null,
        pathHint: f.folder_name || null,
      });
    } else if (!existing.fileId) {
      existing.fileId = f.id;
      existing.status = f.status || null;
    }
  }

  return [...groups.values()].map((g, i) => {
    const ready = (g.status || "").toLowerCase() === "ready";
    return {
      id: -(i + 1),
      kind: "infocard" as const,
      title: g.title,
      subtitle: g.pathHint
        ? `Infocard · ${g.pathHint}`
        : ready
          ? "Infocard · есть PDF"
          : "Infocard · карточка",
      infocard_id: g.fileId,
      infocard_status: g.status,
      infocard_folder_id: g.folderId || null,
      infocard_folder_name: g.title,
    };
  });
}
/** Поиск адресов и объектов ограничен этим радиусом вокруг города по умолчанию. */
const SEARCH_RADIUS_KM = 50;
/** Сколько точек максимум рисовать на карте за раз — больше сильно подвисает UI. */
const MAP_POINTS_LIMIT = 5000;

function guessWaterType(name: string, comment?: string | null): WaterType {
  const t = `${name} ${comment || ""}`.toLowerCase();
  if (t.includes("гидрант") || t.includes("пг") || t.includes("hydrant")) return "hydrant";
  if (t.includes("пруд") || t.includes("водоём") || t.includes("водоем") || t.includes("озеро"))
    return "pond";
  if (t.includes("башня") || t.includes("tower")) return "tower";
  if (t.includes("пирс") || t.includes("причал") || t.includes("pier")) return "pier";
  return "other";
}

function markersToWaterPoints(markers: UserMarker[]): WaterPoint[] {
  return markers
    .filter((m) => Number.isFinite(m.lat) && Number.isFinite(m.lon))
    .map((m) => ({
      id: m.id,
      name: m.name,
      water_type: guessWaterType(m.name, m.comment),
      lat: m.lat,
      lon: m.lon,
      address: null,
      description: m.comment,
      source_path: null,
    }));
}

function filterPointsInBounds(
  pts: WaterPoint[],
  b: { south: number; west: number; north: number; east: number }
): WaterPoint[] {
  const inB = pts.filter(
    (p) => p.lat >= b.south && p.lat <= b.north && p.lon >= b.west && p.lon <= b.east
  );
  return inB.length > MAP_POINTS_LIMIT ? inB.slice(0, MAP_POINTS_LIMIT) : inB;
}

function nearbyFromPoints(
  pts: WaterPoint[],
  lat: number,
  lon: number,
  limit: number
): NearbyPoint[] {
  return pts
    .map((p) => ({
      id: p.id,
      name: p.name,
      water_type: p.water_type,
      lat: p.lat,
      lon: p.lon,
      distance_m: distanceKm(lat, lon, p.lat, p.lon) * 1000,
    }))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

type SideMode = "search" | "history" | "favorites" | "markers";

function addressFromDescription(raw?: string | null): string | null {
  if (!raw) return null;
  const text = raw
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\r/g, "");
  const match = text.match(
    /(?:Улица\s*\(наименование объекта\)|Адрес)\s*:\s*([^\n]+?)(?=\s+(?:Техническое состояние|Характер неисправности|Дата последней|Принадлежность|Координаты|Место нахождения|Расстояние)|$)/i
  );
  return match?.[1]?.trim() || null;
}

function isLikelyAddress(query: string): boolean {
  return (
    /\d/.test(query) ||
    /\b(ул\.?|улица|проспект|пр-т|переулок|пер\.?|шоссе|проезд|бульвар|наб\.?|набережная|дом|д\.)\b/i.test(
      query
    )
  );
}

/** Нормализация адреса карточки для геокодера (п-т. → проспект и т.п.). */
function normalizeAddressForGeocode(raw: string, city?: string): string {
  let s = raw.trim();
  s = s
    .replace(/\bп-?т\.?\b/gi, "проспект")
    .replace(/\bпр-?т\.?\b/gi, "проспект")
    .replace(/\bпр\.?\b/gi, "проспект")
    .replace(/\bул\.?\b/gi, "улица")
    .replace(/\bпер\.?\b/gi, "переулок")
    .replace(/\bнаб\.?\b/gi, "набережная")
    .replace(/\bпл\.?\b/gi, "площадь")
    .replace(/\bмкр\.?\b/gi, "микрорайон")
    .replace(/\s+/g, " ")
    .trim();
  const cityName = city?.trim();
  if (cityName && !s.toLowerCase().includes(cityName.toLowerCase())) {
    s = `${s}, ${cityName}`;
  }
  return s;
}

/** Достаём хвост адреса из названия папки ИК. */
function addressFromCardTitle(title: string): string | null {
  const byComma = title.split(",").map((x) => x.trim()).filter(Boolean);
  if (byComma.length >= 2) {
    const tail = byComma.slice(-2).join(", ");
    if (tail.length > 5) return tail;
  }
  const guillemet = title.lastIndexOf("»");
  if (guillemet >= 0) {
    const tail = title.slice(guillemet + 1).replace(/^[\s,]+/, "").trim();
    if (tail.length > 5) return tail;
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hitMatchesAddress(hit: SearchHit, streetTokens: string[], house: string | null): boolean {
  const hay = `${hit.title} ${hit.address || ""} ${hit.subtitle || ""}`.toLowerCase();
  if (house) {
    const re = new RegExp(`(^|[^0-9])${escapeRegExp(house)}([^0-9а-яa-z]|$)`, "i");
    if (!re.test(hay)) return false;
  }
  if (streetTokens.length > 0) {
    // Достаточно одного совпадения по улице: в ИК часто только «Ленина 62б» без города/типа улицы
    const streetHit = streetTokens.some((t) => hay.includes(t));
    if (!streetHit) return false;
  }
  return streetTokens.length > 0 || Boolean(house);
}

function nearbyToSearchHit(n: NearbyPoint): SearchHit {
  return {
    id: n.id,
    kind: "water",
    title: n.name,
    subtitle: `${Math.round(n.distance_m)} м`,
    water_type: n.water_type,
    lat: n.lat,
    lon: n.lon,
    distance_m: n.distance_m,
  };
}

function addressFromSubtitle(subtitle: string): string | null {
  const parts = subtitle.split("·").map((s) => s.trim()).filter(Boolean);
  for (const part of parts) {
    if (/\d/.test(part) && !/^№/i.test(part)) return part;
  }
  return null;
}

function dotIcon(color: string, size: number, ring = false) {
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:${
      ring ? `0 0 0 6px ${color}55,` : ""
    }0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const SEARCH_PIN_ICON = dotIcon("#ffcc00", 18, true);
const USER_MARKER_ICON = dotIcon("#9b59b6", 16);

function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    map.flyTo(center, Math.max(map.getZoom(), zoomRef.current), { duration: 0.6 });
  }, [center, map]);
  return null;
}

function MapClickCatcher({
  enabled,
  onPick,
}: {
  enabled: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click: (e) => {
      if (enabled) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function BoundsLoader({
  onBounds,
}: {
  onBounds: (b: { south: number; west: number; north: number; east: number }) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      notify();
    },
    zoomend: () => {
      notify();
    },
  });

  function notify() {
    const b = map.getBounds();
    onBounds({
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
    });
  }

  useEffect(() => {
    notify();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

function NearbySection({
  nearby,
  onSelect,
}: {
  nearby: NearbyPoint[];
  onSelect: (n: NearbyPoint) => void;
}) {
  return (
    <div>
      <h3 style={{ margin: "0.5rem 0" }}>Ближайшие ИППВ</h3>
      {nearby.length === 0 && <div className="muted">Нет данных поблизости</div>}
      <div className="nearby-list">
        {nearby.map((n) => (
          <button
            key={n.id}
            type="button"
            className="nearby-item"
            style={{ width: "100%", cursor: "pointer", textAlign: "left" }}
            onClick={() => onSelect(n)}
          >
            <strong>
              {WATER_TYPE_SHORT[n.water_type]} · {n.name}
            </strong>
            <div className="muted">{Math.round(n.distance_m)} м</div>
          </button>
        ))}
      </div>
    </div>
  );
}

interface Props {
  settings: AppSettings;
  onOpenCard: (cardId: number) => void;
}

export function MapPage({ settings, onOpenCard }: Props) {
  const serverWaterMode = (settings.markers_mode || "local") === "server";
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [points, setPoints] = useState<WaterPoint[]>([]);
  /** Полный список серверных водоисточников (для поиска и фильтра по viewport). */
  const [serverPointsAll, setServerPointsAll] = useState<WaterPoint[]>([]);
  const lastBoundsRef = useRef<{
    south: number;
    west: number;
    north: number;
    east: number;
  } | null>(null);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [water, setWater] = useState<WaterPoint | null>(null);
  const [nearby, setNearby] = useState<NearbyPoint[]>([]);
  const [center, setCenter] = useState<[number, number]>([
    settings.default_lat,
    settings.default_lon,
  ]);
  const [focusZoom, setFocusZoom] = useState(settings.default_zoom || 13);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [localPack, setLocalPack] = useState<MapPackageInfo | null>(null);
  const [history, setHistory] = useState<SearchHit[]>([]);
  const [favorites, setFavorites] = useState<SearchHit[]>([]);
  const [sideMode, setSideMode] = useState<SideMode>("search");
  const [activeIndex, setActiveIndex] = useState(0);

  const [searchPin, setSearchPin] = useState<SearchPin | null>(null);
  const [geoBusy, setGeoBusy] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);

  const [markers, setMarkers] = useState<UserMarker[]>([]);
  const [markerFile, setMarkerFile] = useState<MarkerFileInfo | null>(null);
  const [pickMode, setPickMode] = useState(false);
  /** Перенос ИППВ: клик по карте задаёт новые координаты. */
  const [moveWaterId, setMoveWaterId] = useState<number | null>(null);
  /** При правке метки FireAtlas — выбрать новое место кликом. */
  const [pickForEditMarker, setPickForEditMarker] = useState(false);
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftComment, setDraftComment] = useState("");
  const [markerError, setMarkerError] = useState<string | null>(null);
  const [markerBusy, setMarkerBusy] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [infocardFiles, setInfocardFiles] = useState<api.InfocardFileHit[]>([]);
  const [infocardFilesError, setInfocardFilesError] = useState<string | null>(null);
  const [pdfPreview, setPdfPreview] = useState<{ url: string; title: string; path: string } | null>(
    null
  );
  const draftNameRef = useRef<HTMLInputElement>(null);

  const useLocalMap = Boolean(settings.local_map_path);
  const sideList =
    sideMode === "search" ? hits : sideMode === "history" ? history : sideMode === "favorites" ? favorites : [];
  const description = useMemo(() => {
    const raw = water?.description;
    if (!raw || !hasReadableText(raw)) return null;
    return sanitizeDescription(raw);
  }, [water?.description]);
  const visibleAddress = useMemo(
    () => selected?.address || water?.address || addressFromDescription(water?.description),
    [selected?.address, water?.address, water?.description]
  );

  async function refreshLists() {
    const [h, f] = await Promise.all([api.getHistory(15), api.getFavorites()]);
    setHistory(h);
    setFavorites(f);
  }

  const applyMarkers = useCallback((state: MarkersState) => {
    setMarkers(state.markers);
    setMarkerFile(state.file);
    setMarkerError(state.file_error);
  }, []);

  const applyServerWater = useCallback((state: MarkersState) => {
    const pts = markersToWaterPoints(state.markers);
    setServerPointsAll(pts);
    setMarkers([]);
    setMarkerFile(null);
    setMarkerError(state.file_error);
    const b = lastBoundsRef.current;
    if (b) {
      setPoints(filterPointsInBounds(pts, b));
    } else {
      setPoints(pts.length > MAP_POINTS_LIMIT ? pts.slice(0, MAP_POINTS_LIMIT) : pts);
    }
  }, []);

  async function refreshServerWater() {
    setMarkerBusy(true);
    setMarkerError(null);
    try {
      applyServerWater(await api.infocardListMarkers());
    } catch (e) {
      setServerPointsAll([]);
      setPoints([]);
      setMarkerError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarkerBusy(false);
    }
  }

  useEffect(() => {
    void refreshLists();
  }, []);

  useEffect(() => {
    if (!useLocalMap || !settings.local_map_path) {
      setLocalPack(null);
      return;
    }
    void (async () => {
      try {
        const packs = await api.listMapPackages();
        const match =
          packs.find((p) => p.path === settings.local_map_path) ||
          packs.find((p) => p.id === settings.local_map_city_id) ||
          packs.find((p) => p.ready) ||
          null;
        setLocalPack(match);
      } catch {
        setLocalPack(null);
      }
    })();
  }, [useLocalMap, settings.local_map_path, settings.local_map_city_id]);

  useEffect(() => {
    void (async () => {
      try {
        if (serverWaterMode) {
          applyServerWater(await api.infocardListMarkers());
        } else {
          setServerPointsAll([]);
          applyMarkers(await api.listMarkers());
          const b = lastBoundsRef.current;
          if (b) {
            const pts = await api.getWaterInBounds(
              b.south,
              b.west,
              b.north,
              b.east,
              ALL_TYPES
            );
            setPoints(pts.length > MAP_POINTS_LIMIT ? pts.slice(0, MAP_POINTS_LIMIT) : pts);
          } else {
            setPoints([]);
          }
        }
      } catch (e) {
        if (serverWaterMode) {
          setServerPointsAll([]);
          setPoints([]);
        }
        setMarkerError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [applyMarkers, applyServerWater, settings.data_path, serverWaterMode]);

  useEffect(() => {
    setCenter([settings.default_lat, settings.default_lon]);
  }, [settings.default_lat, settings.default_lon]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        if (!query.trim()) {
          setHits([]);
          setSearchPin(null);
          setGeoError(null);
          return;
        }
        const q = query.trim().toLowerCase();
        const cardsMode = settings.cards_mode || "local";
        const wantLocalCards = cardsMode === "local" || cardsMode === "both";
        const wantServerCards = cardsMode === "server" || cardsMode === "both";

        let waterHits: SearchHit[] = [];
        if (serverWaterMode) {
          waterHits = serverPointsAll
            .filter((p) => {
              const hay = `${p.name} ${p.description || ""}`.toLowerCase();
              return hay.includes(q);
            })
            .slice(0, 40)
            .map((p) => ({
              id: p.id,
              kind: "water" as const,
              title: p.name,
              subtitle: p.description || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
              water_type: p.water_type,
              address: p.address,
              lat: p.lat,
              lon: p.lon,
            }));
        } else {
          const res = await api.search(query, ALL_TYPES, 80);
          waterHits = res.filter((hit) => {
            if (hit.kind !== "water") return false;
            if (hit.lat == null || hit.lon == null) return true;
            return (
              distanceKm(settings.default_lat, settings.default_lon, hit.lat, hit.lon) <=
              SEARCH_RADIUS_KM
            );
          });
        }

        let cardHits: SearchHit[] = [];
        if (wantLocalCards) {
          const res = await api.search(query, ALL_TYPES, 80);
          cardHits = res.filter((hit) => {
            if (hit.kind !== "card") return false;
            if (hit.lat == null || hit.lon == null) return true;
            return (
              distanceKm(settings.default_lat, settings.default_lon, hit.lat, hit.lon) <=
              SEARCH_RADIUS_KM
            );
          });
        }

        let infocardHits: SearchHit[] = [];
        if (wantServerCards && q.length >= 2) {
          try {
            const files = await api.infocardSearchFiles(query.trim(), INFOCARD_SEARCH_LIMIT);
            infocardHits = groupInfocardSearchHits(files);
          } catch (err) {
            setGeoError(
              err instanceof Error
                ? err.message
                : "Не удалось искать карточки Infocard (проверьте вход в настройках)"
            );
          }
        }

        setHits([...cardHits, ...infocardHits, ...waterHits].slice(0, 80));
        setActiveIndex(0);
      })();
    }, 180);
    return () => window.clearTimeout(t);
  }, [
    query,
    settings.default_lat,
    settings.default_lon,
    settings.cards_mode,
    serverWaterMode,
    serverPointsAll,
  ]);

  useEffect(() => {
    setActiveIndex(0);
  }, [sideMode]);

  const loadBounds = useCallback(
    async (b: { south: number; west: number; north: number; east: number }) => {
      lastBoundsRef.current = b;
      if (serverWaterMode) {
        setPoints(filterPointsInBounds(serverPointsAll, b));
        return;
      }
      const pts = await api.getWaterInBounds(b.south, b.west, b.north, b.east, ALL_TYPES);
      setPoints(pts.length > MAP_POINTS_LIMIT ? pts.slice(0, MAP_POINTS_LIMIT) : pts);
    },
    [serverWaterMode, serverPointsAll]
  );

  const boundsTimer = useRef<number | null>(null);
  const onBoundsChangeDebounced = useCallback(
    (b: { south: number; west: number; north: number; east: number }) => {
      if (boundsTimer.current != null) window.clearTimeout(boundsTimer.current);
      boundsTimer.current = window.setTimeout(() => {
        void loadBounds(b);
      }, 280);
    },
    [loadBounds]
  );

  function moveTo(lat: number, lon: number, zoom = 15) {
    setFocusZoom(zoom);
    setCenter([lat, lon]);
  }

  async function selectHit(hit: SearchHit, fallbackQuery?: string) {
    setSelected(hit);
    setGeoError(null);
    setMoveWaterId(null);
    setInfocardFiles([]);
    setInfocardFilesError(null);

    if (hit.kind === "infocard") {
      setWater(null);
      setFocusId(null);
      setNearby([]);
      void loadInfocardCardFiles(hit);
      return;
    }

    // Сразу двигаем карту по координатам из результата (Enter / клик).
    if (hit.lat != null && hit.lon != null) {
      moveTo(hit.lat, hit.lon, hit.kind === "card" ? ADDRESS_ZOOM : 15);
      if (hit.kind === "water") setFocusId(hit.id);
    }
    try {
      await api.addHistory(hit.kind, hit.id, hit.title);
    } catch {
      /* ignore */
    }
    void refreshLists();
    if (hit.kind === "water") {
      let wp: WaterPoint | null = null;
      if (serverWaterMode) {
        wp =
          serverPointsAll.find((p) => p.id === hit.id) ||
          points.find((p) => p.id === hit.id) ||
          null;
        if (!wp && hit.lat != null && hit.lon != null) {
          wp = {
            id: hit.id,
            name: hit.title,
            water_type: hit.water_type || "other",
            lat: hit.lat,
            lon: hit.lon,
            address: hit.address || null,
            description: hit.subtitle || null,
            source_path: null,
          };
        }
      } else {
        wp = await api.getWaterPoint(hit.id);
      }
      setWater(wp);
      if (wp) {
        moveTo(wp.lat, wp.lon);
        setFocusId(wp.id);
        if (serverWaterMode) {
          setNearby(nearbyFromPoints(serverPointsAll, wp.lat, wp.lon, 8));
        } else {
          setNearby(await api.nearby(wp.lat, wp.lon, 8, ALL_TYPES));
        }
      }
      return;
    }

    setWater(null);
    setFocusId(null);
    const card = await api.getCard(hit.id);
    if (card?.lat != null && card.lon != null) {
      moveTo(card.lat, card.lon, ADDRESS_ZOOM);
      setNearby(await api.nearby(card.lat, card.lon, 8, ALL_TYPES));
      return;
    }

    // Привязка к адресу: пробуем несколько вариантов строки для геокодера
    const candidates = [
      card?.address,
      hit.address,
      addressFromSubtitle(hit.subtitle),
      addressFromCardTitle(card?.title || hit.title),
      fallbackQuery?.trim(),
      query.trim(),
    ]
      .filter((x): x is string => !!x && x.trim().length > 3)
      .map((x) => normalizeAddressForGeocode(x, settings.default_city));

    const unique = [...new Set(candidates)];
    let lastErr = "Адрес карточки не удалось показать на карте";
    for (const addr of unique) {
      try {
        const found = await geocodeAddress(addr, settings.yandex_api_key, {
          lat: settings.default_lat,
          lon: settings.default_lon,
          city: settings.default_city,
          radiusKm: SEARCH_RADIUS_KM,
        });
        const num = card?.number ? ` №${card.number}` : "";
        setSearchPin({
          ...found,
          label: `ИК${num}: ${found.label}`,
        });
        moveTo(found.lat, found.lon, ADDRESS_ZOOM);
        setNearby(await api.nearby(found.lat, found.lon, 8, ALL_TYPES));
        setGeoError(null);
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }
    setNearby([]);
    setGeoError(
      `Карточка выбрана, но на карту не перешли: ${lastErr}. Проверьте интернет или уточните адрес.`
    );
  }

  /** Геокодирование + подбор информационной карточки по адресу. */
  async function findAddress(text: string) {
    const q = text.trim();
    if (!q) return;
    setGeoBusy(true);
    setGeoError(null);
    try {
      const parsed = parseAddressQuery(q);
      const found = await geocodeAddress(
        normalizeAddressForGeocode(q, settings.default_city),
        settings.yandex_api_key,
        {
          lat: settings.default_lat,
          lon: settings.default_lon,
          city: settings.default_city,
          radiusKm: SEARCH_RADIUS_KM,
        }
      );
      setSearchPin(found);
      setFocusId(null);
      moveTo(found.lat, found.lon, ADDRESS_ZOOM);
      const nearbyPoints = await api.nearby(found.lat, found.lon, 8, ALL_TYPES);
      setNearby(nearbyPoints);
      setSelected(null);
      setWater(null);
      setSideMode("search");

      const geocodedParsed = parseAddressQuery(found.label);
      const compactParts = [
        ...(parsed.streetTokens.length ? parsed.streetTokens : geocodedParsed.streetTokens),
        parsed.house || geocodedParsed.house || "",
      ].filter(Boolean);
      const compactQuery = compactParts.join(" ");

      const searches = [q, found.label, compactQuery].filter(
        (s, i, arr) => s.trim().length > 0 && arr.indexOf(s) === i
      );
      const batches = await Promise.all(searches.map((s) => api.search(s, ALL_TYPES, 80)));

      const cardMap = new Map<number, SearchHit>();
      for (const hit of batches.flat()) {
        if (hit.kind !== "card") continue;
        if (
          hitMatchesAddress(hit, parsed.streetTokens, parsed.house) ||
          hitMatchesAddress(hit, geocodedParsed.streetTokens, geocodedParsed.house) ||
          (compactParts.length > 0 &&
            hitMatchesAddress(
              hit,
              parsed.streetTokens.length ? parsed.streetTokens : geocodedParsed.streetTokens,
              parsed.house || geocodedParsed.house
            ))
        ) {
          cardMap.set(hit.id, hit);
        }
      }

      const cards = [...cardMap.values()];
      const waters = nearbyPoints.map(nearbyToSearchHit);
      setHits([...cards, ...waters].slice(0, 40));
      setActiveIndex(0);
    } catch (e) {
      setSearchPin(null);
      setGeoError(e instanceof Error ? e.message : String(e));
      setHits([]);
      setNearby([]);
    } finally {
      setGeoBusy(false);
    }
  }

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || !isLikelyAddress(q)) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void suggestAddresses(q, {
        lat: settings.default_lat,
        lon: settings.default_lon,
        city: settings.default_city,
        radiusKm: SEARCH_RADIUS_KM,
      })
        .then((items) => {
          if (!cancelled) setSuggestions(items);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, settings.default_city, settings.default_lat, settings.default_lon]);

  function applySuggestion(label: string) {
    setQuery(label);
    setSuggestions([]);
    setShowSuggestions(false);
    void findAddress(label);
  }

  function onSearchKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (sideList.length === 0) return;
      setActiveIndex((i) => Math.min(i + 1, sideList.length - 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (sideList.length === 0) return;
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      // Для адресного запроса всегда геокодируем набранный текст,
      // а не открываем первую карточку из FTS (там часто чужой № дома / ИК).
      if (sideMode === "search" && isLikelyAddress(query)) {
        void findAddress(query);
        return;
      }
      const hit = sideList[activeIndex] ?? sideList[0];
      if (hit) {
        void selectHit(hit, query);
      } else if (sideMode === "search") {
        void findAddress(query);
      }
    }
  }

  function onPointClick(p: WaterPoint) {
    void selectHit({
      id: p.id,
      kind: "water",
      title: p.name,
      subtitle: p.address || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
      water_type: p.water_type,
      address: p.address,
      lat: p.lat,
      lon: p.lon,
    });
  }

  function startDraft(lat: number, lon: number, name = "") {
    if (serverWaterMode) {
      setMarkerError(
        "Серверные водоисточники правятся в веб-кабинете Infocard. В приложении — только просмотр."
      );
      setSideMode("markers");
      return;
    }
    setPickMode(false);
    setPickForEditMarker(false);
    setMoveWaterId(null);
    setMarkerError(null);
    setEditingId(null);
    setDraft({ lat, lon });
    setDraftName(name);
    setDraftComment("");
    setSideMode("markers");
    window.setTimeout(() => draftNameRef.current?.focus(), 0);
  }

  async function onMapPick(lat: number, lon: number) {
    if (moveWaterId != null) {
      const id = moveWaterId;
      setMoveWaterId(null);
      setPickMode(false);
      setMarkerBusy(true);
      setMarkerError(null);
      try {
        const updated = await api.moveWaterPoint(id, lat, lon);
        setWater(updated);
        setPoints((prev) => prev.map((p) => (p.id === id ? { ...p, lat, lon } : p)));
        setSelected((prev) =>
          prev && prev.kind === "water" && prev.id === id
            ? { ...prev, lat, lon, subtitle: `${lat.toFixed(5)}, ${lon.toFixed(5)}` }
            : prev
        );
        moveTo(lat, lon, 16);
        setFocusId(id);
        setNearby(await api.nearby(lat, lon, 8, ALL_TYPES));
      } catch (e) {
        setGeoError(e instanceof Error ? e.message : String(e));
      } finally {
        setMarkerBusy(false);
      }
      return;
    }
    if (pickForEditMarker && draft) {
      setDraft({ lat, lon });
      setPickForEditMarker(false);
      setPickMode(false);
      moveTo(lat, lon, 16);
      return;
    }
    startDraft(lat, lon);
  }

  async function removeWaterPoint() {
    if (!water || markerBusy || serverWaterMode) return;
    if (
      !window.confirm(
        `Удалить «${water.name}» из файла карты?\n${water.source_path || ""}\nЭто изменит KMZ/KML на диске.`
      )
    ) {
      return;
    }
    setMarkerBusy(true);
    setMarkerError(null);
    const id = water.id;
    try {
      await api.deleteWaterPoint(id);
      setPoints((prev) => prev.filter((p) => p.id !== id));
      setWater(null);
      setSelected(null);
      setFocusId(null);
      setNearby([]);
    } catch (e) {
      setGeoError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarkerBusy(false);
    }
  }

  function beginMoveWater() {
    if (!water || serverWaterMode) return;
    setMoveWaterId(water.id);
    setPickMode(true);
    setPickForEditMarker(false);
    setSideMode("search");
  }

  async function loadInfocardCardFiles(hit: SearchHit) {
    setInfocardFilesError(null);
    setMarkerBusy(true);
    try {
      let folderId = hit.infocard_folder_id || null;
      if (!folderId && hit.infocard_id) {
        const meta = await api.infocardGetFile(hit.infocard_id);
        folderId = meta.folder_id || null;
      }
      if (!folderId) {
        if (hit.infocard_id) {
          setInfocardFiles([
            {
              id: hit.infocard_id,
              name: hit.title,
              status: hit.infocard_status,
              kind: "file",
              folder_id: null,
              has_pdf: (hit.infocard_status || "").toLowerCase() === "ready",
            },
          ]);
        } else {
          setInfocardFilesError("Не удалось определить папку карточки на сервере");
        }
        return;
      }
      const files = await api.infocardListFolderFiles(folderId);
      setInfocardFiles(files);
      if (files.length === 0) {
        setInfocardFilesError("В папке карточки нет файлов");
      }
    } catch (e) {
      setInfocardFilesError(e instanceof Error ? e.message : String(e));
    } finally {
      setMarkerBusy(false);
    }
  }

  async function openInfocardFile(file: api.InfocardFileHit) {
    const ready =
      file.has_pdf === true || (file.status || "").toLowerCase() === "ready";
    if (!ready) {
      setGeoError(
        "PDF ещё не готов (Visio/фото/Word конвертируются на сервере). Подождите и обновите список."
      );
      return;
    }
    setMarkerBusy(true);
    setGeoError(null);
    try {
      const path = await api.infocardOpenPdf(file.id);
      setPdfPreview({
        url: convertFileSrc(path),
        title: `${infocardFileRole(file.name)} · ${file.name}`,
        path,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGeoError(
        msg.includes("404") || msg.toLowerCase().includes("not ready")
          ? "PDF ещё не готов или файл не найден."
          : msg
      );
    } finally {
      setMarkerBusy(false);
    }
  }

  async function openInfocardHit(hit: SearchHit) {
    await loadInfocardCardFiles(hit);
  }

  async function saveDraft() {
    if (!draft || markerBusy) return;
    if (serverWaterMode) {
      setMarkerError(
        "Серверные водоисточники правятся в веб-кабинете Infocard. В приложении — только просмотр."
      );
      return;
    }
    if (!draftName.trim()) {
      setMarkerError("Укажите название метки");
      draftNameRef.current?.focus();
      return;
    }
    const name = draftName.trim();
    const comment = draftComment.trim() || null;
    const { lat, lon } = draft;
    const editId = editingId;

    // Сразу закрываем форму — защита от повторных нажатий.
    setMarkerBusy(true);
    setMarkerError(null);
    setDraft(null);
    setDraftName("");
    setDraftComment("");
    setEditingId(null);

    try {
      if (editId != null) {
        applyMarkers(await api.updateMarker(editId, name, comment, lat, lon));
      } else {
        // Пишем в тот же KMZ/KML, что на карте (файл гидрантов / активный источник).
        const sourcePath = water?.source_path ?? points[0]?.source_path ?? null;
        applyMarkers(await api.addMarker(name, comment, lat, lon, sourcePath));
      }
    } catch (e) {
      setMarkerError(e instanceof Error ? e.message : String(e));
      // Вернуть форму при ошибке
      setDraft({ lat, lon });
      setDraftName(name);
      setDraftComment(comment || "");
      setEditingId(editId);
    } finally {
      setMarkerBusy(false);
    }
  }

  async function removeMarker(id: number) {
    if (markerBusy) return;
    setMarkerBusy(true);
    setMarkerError(null);
    // Оптимистично убираем из списка
    setMarkers((prev) => prev.filter((m) => m.id !== id));
    try {
      applyMarkers(await api.deleteMarker(id));
    } catch (e) {
      setMarkerError(e instanceof Error ? e.message : String(e));
      try {
        applyMarkers(await api.listMarkers());
      } catch {
        /* ignore */
      }
    } finally {
      setMarkerBusy(false);
    }
  }

  function beginEdit(m: (typeof markers)[number]) {
    setEditingId(m.id);
    setDraft({ lat: m.lat, lon: m.lon });
    setDraftName(m.name);
    setDraftComment(m.comment || "");
    setSideMode("markers");
    setPickMode(false);
    setPickForEditMarker(false);
    setMoveWaterId(null);
    window.setTimeout(() => draftNameRef.current?.focus(), 0);
  }

  function selectNearby(n: NearbyPoint) {
    void selectHit({
      id: n.id,
      kind: "water",
      title: n.name,
      subtitle: `${Math.round(n.distance_m)} м`,
      water_type: n.water_type,
      lat: n.lat,
      lon: n.lon,
    });
  }

  return (
    <div className="panel map-layout">
      <aside className="side">
        <div className="city-field">
          <input
            id="global-search"
            className="search-box"
            placeholder={`Адрес в ${settings.default_city || "городе"} (±${SEARCH_RADIUS_KM} км)…`}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSideMode("search");
              setShowSuggestions(true);
            }}
            onFocus={() => setShowSuggestions(true)}
            onBlur={() => {
              window.setTimeout(() => setShowSuggestions(false), 150);
            }}
            onKeyDown={onSearchKeyDown}
          />
          {showSuggestions && suggestions.length > 0 && (
            <div className="city-hints">
              {suggestions.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  className="city-hint"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applySuggestion(item.label)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn primary"
            disabled={geoBusy || !query.trim()}
            onClick={() => void findAddress(query)}
          >
            {geoBusy ? "Ищем адрес…" : "Найти адрес"}
          </button>
          {searchPin && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                setSearchPin(null);
                setGeoError(null);
              }}
            >
              Убрать метку адреса
            </button>
          )}
        </div>
        {geoError && (
          <div className="status-banner" style={{ whiteSpace: "pre-wrap" }}>
            {geoError}
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            className={`btn ${sideMode === "search" ? "primary" : ""}`}
            onClick={() => setSideMode("search")}
          >
            Поиск
          </button>
          <button
            type="button"
            className={`btn ${sideMode === "history" ? "primary" : ""}`}
            onClick={() => {
              setSideMode("history");
              void refreshLists();
            }}
          >
            История
          </button>
          <button
            type="button"
            className={`btn ${sideMode === "favorites" ? "primary" : ""}`}
            onClick={() => {
              setSideMode("favorites");
              void refreshLists();
            }}
          >
            Избранное
          </button>
          <button
            type="button"
            className={`btn ${sideMode === "markers" ? "primary" : ""}`}
            onClick={() => setSideMode("markers")}
          >
            {serverWaterMode
              ? `С сервера (${serverPointsAll.length})`
              : `Метки (${markers.length})`}
          </button>
        </div>

        {serverWaterMode && (
          <div className="actions" style={{ marginTop: 4 }}>
            <button
              type="button"
              className="btn"
              disabled={markerBusy}
              onClick={() => void refreshServerWater()}
            >
              {markerBusy ? "Обновление…" : "Обновить с сервера"}
            </button>
          </div>
        )}

        {water && !serverWaterMode && (
          <div className="water-edit-bar">
            <div className="water-edit-title">{water.name}</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
              ИППВ · правки пишутся в файл карты
            </div>
            <div className="actions">
              <button
                type="button"
                className="btn danger"
                disabled={markerBusy}
                onClick={() => void removeWaterPoint()}
              >
                Удалить с карты
              </button>
              <button
                type="button"
                className="btn"
                disabled={markerBusy}
                onClick={() => beginMoveWater()}
              >
                {moveWaterId === water.id ? "Кликните на карте…" : "Перенести"}
              </button>
            </div>
          </div>
        )}

        {water && serverWaterMode && (
          <div className="water-edit-bar">
            <div className="water-edit-title">{water.name}</div>
            <div className="muted" style={{ fontSize: 12 }}>
              Водоисточник с сервера · только просмотр
            </div>
          </div>
        )}

        {sideMode === "markers" ? (
          <div className="results">
            {markerError && (
              <div className="status-banner" style={{ whiteSpace: "pre-wrap" }}>
                {markerError}
              </div>
            )}

            {serverWaterMode ? (
              <>
                <div className="empty">
                  Водоисточники с сервера Infocard. Редактирование — в веб-кабинете. Здесь только
                  просмотр.
                </div>
                {serverPointsAll.length === 0 && !markerError && (
                  <div className="muted">Нет точек. Войдите в Infocard в настройках и нажмите «Обновить».</div>
                )}
                {serverPointsAll.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="result-item"
                    onClick={() =>
                      void selectHit({
                        id: p.id,
                        kind: "water",
                        title: p.name,
                        subtitle: p.description || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`,
                        water_type: p.water_type,
                        address: p.address,
                        lat: p.lat,
                        lon: p.lon,
                      })
                    }
                  >
                    <div className="title">
                      <span className={`badge ${p.water_type}`}>{WATER_TYPE_SHORT[p.water_type]}</span>
                      {p.name}
                    </div>
                    <div className="meta">
                      {p.description ? `${p.description} · ` : ""}
                      {p.lat.toFixed(5)}, {p.lon.toFixed(5)}
                    </div>
                  </button>
                ))}
              </>
            ) : (
              <>
            {draft && (
              <div className="marker-form">
                <strong>{editingId != null ? "Изменить метку" : "Новая метка"}</strong>
                <div className="muted">
                  {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
                </div>
                <input
                  ref={draftNameRef}
                  className="search-box"
                  placeholder="Название метки"
                  value={draftName}
                  disabled={markerBusy}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void saveDraft();
                    }
                  }}
                />
                <input
                  className="search-box"
                  placeholder="Комментарий (необязательно)"
                  value={draftComment}
                  disabled={markerBusy}
                  onChange={(e) => setDraftComment(e.target.value)}
                />
                <div className="actions">
                  <button
                    type="button"
                    className="btn primary"
                    disabled={markerBusy}
                    onClick={() => void saveDraft()}
                  >
                    {markerBusy ? "Сохранение…" : "Сохранить"}
                  </button>
                  {editingId != null && (
                    <button
                      type="button"
                      className="btn"
                      disabled={markerBusy}
                      onClick={() => {
                        setPickForEditMarker(true);
                        setPickMode(true);
                        setMoveWaterId(null);
                      }}
                    >
                      Указать место на карте
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn"
                    disabled={markerBusy}
                    onClick={() => {
                      setDraft(null);
                      setEditingId(null);
                      setPickForEditMarker(false);
                    }}
                  >
                    Отмена
                  </button>
                </div>
                {draft && (
                  <div className="muted" style={{ fontSize: 13 }}>
                    Координаты: {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
                    {pickForEditMarker ? " — щёлкните новое место на карте" : ""}
                  </div>
                )}
              </div>
            )}

            {!draft && markers.length === 0 && (
              <div className="empty">
                Меток пока нет. Нажмите «Поставить метку» на карте и щёлкните по нужному месту.
                Красные точки — гидранты из KMZ (их здесь не удаляют). Ваши метки FireAtlas удаляются
                кнопкой «Удалить» — сразу из списка и из блока меток в файле карты.
              </div>
            )}

            {markers.map((m) => (
              <div key={m.id} className="marker-row">
                <button
                  type="button"
                  className="result-item"
                  style={{ flex: 1 }}
                  onClick={() => moveTo(m.lat, m.lon, 16)}
                >
                  <div className="title">
                    <span className="badge marker">Метка</span>
                    {m.name}
                  </div>
                  <div className="meta">
                    {m.comment ? `${m.comment} · ` : ""}
                    {m.lat.toFixed(5)}, {m.lon.toFixed(5)}
                  </div>
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={markerBusy}
                  onClick={() => beginEdit(m)}
                >
                  Изм.
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={markerBusy}
                  title="Удалить из приложения и из файла карты (KMZ/KML)"
                  onClick={() => void removeMarker(m.id)}
                >
                  Удалить
                </button>
              </div>
            ))}

            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {markerFile
                ? `Метки сохраняются в файл карты: ${markerFile.path}. Кнопка «Удалить» убирает метку и из файла.`
                : "Добавьте KML/KMZ в настройках — метки будут записываться в этот же файл карты."}
            </div>
            {markerFile && (
              <button
                type="button"
                className="btn"
                onClick={() => void api.openFolder(markerFile.path)}
              >
                Открыть папку файла меток
              </button>
            )}
              </>
            )}
          </div>
        ) : (
          <div className="results">
            {sideMode === "search" && hits.length === 0 && query.trim() && (
              <div className="empty">Ничего не найдено — попробуйте «Найти адрес»</div>
            )}
            {sideList.map((hit, index) => (
              <button
                key={`${sideMode}-${hit.kind}-${hit.id}-${hit.subtitle}`}
                className={`result-item ${
                  (selected?.id === hit.id && selected.kind === hit.kind) || index === activeIndex
                    ? "active"
                    : ""
                }`}
                onClick={() => void selectHit(hit, query)}
                onMouseEnter={() => setActiveIndex(index)}
                onDoubleClick={() => {
                  void selectHit(hit, query);
                  if (hit.kind === "card") onOpenCard(hit.id);
                }}
              >
                <div className="title">
                  <span
                    className={`badge ${
                      hit.kind === "card" || hit.kind === "infocard"
                        ? "card"
                        : hit.water_type || ""
                    }`}
                  >
                    {hit.kind === "infocard"
                      ? "Infocard"
                      : hit.kind === "card"
                        ? hit.subtitle.startsWith("№")
                          ? hit.subtitle.split(" · ")[0]
                          : "Карточка"
                        : WATER_TYPE_SHORT[hit.water_type || "other"]}
                  </span>
                  {hit.title}
                </div>
                <div className="meta">{hit.subtitle}</div>
              </button>
            ))}
            {sideMode === "history" && history.length === 0 && (
              <div className="empty">История пуста</div>
            )}
            {sideMode === "favorites" && favorites.length === 0 && (
              <div className="empty">Нет избранного</div>
            )}
          </div>
        )}
      </aside>

      <div className="map-pane">
        <div className="map-toolbar">
          {!serverWaterMode && (
            <>
          <button
            type="button"
            className={`btn ${pickMode ? "primary" : ""}`}
            onClick={() => {
              if (pickMode) {
                setPickMode(false);
                setMoveWaterId(null);
                setPickForEditMarker(false);
              } else {
                setMoveWaterId(null);
                setPickForEditMarker(false);
                setPickMode(true);
                setDraft(null);
                setSideMode("markers");
              }
            }}
          >
            {pickMode
              ? moveWaterId != null
                ? "Отменить перенос"
                : pickForEditMarker
                  ? "Отменить выбор места"
                  : "Отменить метку"
              : "Поставить метку"}
          </button>
          {pickMode && (
            <span className="map-toolbar-hint">
              {moveWaterId != null
                ? "Щёлкните новое место для ИППВ"
                : pickForEditMarker
                  ? "Щёлкните новое место метки"
                  : "Щёлкните по карте"}
            </span>
          )}
            </>
          )}
          {serverWaterMode && (
            <span className="map-toolbar-hint">Водоисточники с сервера · только просмотр</span>
          )}
        </div>

        {useLocalMap ? (
          <LocalMapView
            packagePath={settings.local_map_path}
            nativeMinZoom={localPack?.min_zoom || 12}
            nativeMaxZoom={localPack?.max_zoom || 14}
            center={center}
            zoom={focusZoom || settings.default_zoom}
            points={points}
            focusId={focusId}
            searchPin={searchPin}
            markers={markers}
            pickMode={pickMode}
            onPick={(lat, lon) => void onMapPick(lat, lon)}
            onBoundsChange={onBoundsChangeDebounced}
            onPointClick={onPointClick}
          />
        ) : (
          <MapContainer
            center={[settings.default_lat || 55.75, settings.default_lon || 37.62]}
            zoom={settings.default_zoom}
            zoomControl
            style={{ width: "100%", height: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FlyTo center={center} zoom={focusZoom} />
            <MapClickCatcher enabled={pickMode} onPick={(lat, lon) => void onMapPick(lat, lon)} />
            <BoundsLoader onBounds={onBoundsChangeDebounced} />
            <HouseNumbersLayer />
            <WaterClusterLayer
              points={points}
              focusId={focusId}
              pickMode={pickMode}
              onPointClick={onPointClick}
              onPick={(lat, lon) => void onMapPick(lat, lon)}
            />
            {markers.map((m) => (
              <Marker key={`um-${m.id}`} position={[m.lat, m.lon]} icon={USER_MARKER_ICON}>
                <Popup>
                  <strong>{m.name}</strong>
                  {m.comment ? (
                    <>
                      <br />
                      {m.comment}
                    </>
                  ) : null}
                </Popup>
              </Marker>
            ))}
            {searchPin && (
              <Marker position={[searchPin.lat, searchPin.lon]} icon={SEARCH_PIN_ICON}>
                <Popup>{searchPin.label}</Popup>
              </Marker>
            )}
          </MapContainer>
        )}
      </div>

      <aside className="detail">
        {!selected && !searchPin && (
          <div className="empty">Выберите объект на карте или найдите адрес</div>
        )}

        {!selected && searchPin && (
          <>
            <h2 className="address-emphasis">{searchPin.label}</h2>
            <dl>
              <div>
                <dt>Тип</dt>
                <dd>Найденный адрес</dd>
              </div>
              <div>
                <dt>Координаты</dt>
                <dd>
                  {searchPin.lat.toFixed(6)}, {searchPin.lon.toFixed(6)}
                </dd>
              </div>
            </dl>
            <div className="actions">
              <button
                className="btn primary"
                onClick={() => startDraft(searchPin.lat, searchPin.lon, searchPin.label)}
              >
                Поставить метку здесь
              </button>
              <button
                className="btn"
                onClick={() => moveTo(searchPin.lat, searchPin.lon, ADDRESS_ZOOM)}
              >
                Показать на карте
              </button>
            </div>
            <NearbySection nearby={nearby} onSelect={selectNearby} />
          </>
        )}

        {selected && (
          <>
            <h2>{selected.title}</h2>
            <dl>
              <div>
                <dt>Тип</dt>
                <dd>
                  {selected.kind === "infocard"
                    ? "Infocard (сервер)"
                    : selected.kind === "card"
                      ? "Информационная карточка"
                      : WATER_TYPE_SHORT[selected.water_type || "other"]}
                </dd>
              </div>
              <div>
                <dt>Адрес</dt>
                <dd className={visibleAddress ? "address-emphasis" : undefined}>
                  {visibleAddress || "—"}
                </dd>
              </div>
              <div>
                <dt>Координаты</dt>
                <dd>
                  {selected.lat != null && selected.lon != null
                    ? `${selected.lat.toFixed(6)}, ${selected.lon.toFixed(6)}`
                    : water
                      ? `${water.lat.toFixed(6)}, ${water.lon.toFixed(6)}`
                      : "—"}
                </dd>
              </div>
              {description && (
                <div>
                  <dt>Описание</dt>
                  <dd>
                    <div
                      className="kml-description"
                      dangerouslySetInnerHTML={{ __html: description }}
                    />
                  </dd>
                </div>
              )}
            </dl>

            <div className="actions">
              {selected.kind === "card" && (
                <button className="btn primary" onClick={() => onOpenCard(selected.id)}>
                  Открыть карточку
                </button>
              )}
              {selected.kind === "infocard" && (
                <button
                  className="btn primary"
                  disabled={markerBusy}
                  onClick={() => void openInfocardHit(selected)}
                >
                  {infocardFiles.length > 0 ? "Обновить список файлов" : "Открыть карточку"}
                </button>
              )}
              {selected.kind !== "infocard" && (
                <button
                  className="btn"
                  onClick={() =>
                    void (async () => {
                      await api.toggleFavorite(selected.kind, selected.id, selected.title);
                      await refreshLists();
                    })()
                  }
                >
                  В избранное
                </button>
              )}
              {water && (
                <button className="btn" onClick={() => moveTo(water.lat, water.lon, 16)}>
                  Показать на карте
                </button>
              )}
            </div>

            {selected.kind === "infocard" && (
              <div className="infocard-files" style={{ marginTop: 12 }}>
                <h3 style={{ margin: "0 0 8px", fontSize: 15 }}>Файлы карточки</h3>
                {infocardFilesError && <div className="error">{infocardFilesError}</div>}
                {markerBusy && infocardFiles.length === 0 && (
                  <div className="muted">Загрузка файлов…</div>
                )}
                {infocardFiles.length > 0 && (
                  <div className="list">
                    {infocardFiles.map((f) => {
                      const ready =
                        f.has_pdf === true || (f.status || "").toLowerCase() === "ready";
                      return (
                        <div
                          key={f.id}
                          className="list-item"
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 8,
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <strong style={{ display: "block" }}>{infocardFileRole(f.name)}</strong>
                            <div className="muted" style={{ fontSize: 12, wordBreak: "break-word" }}>
                              {f.name}
                              {!ready ? ` · ${f.status || "не готов"}` : " · PDF готов"}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="btn primary"
                            disabled={markerBusy || !ready}
                            onClick={() => void openInfocardFile(f)}
                          >
                            Открыть
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <NearbySection nearby={nearby} onSelect={selectNearby} />
          </>
        )}
      </aside>
      {pdfPreview && (
        <PdfViewer
          url={pdfPreview.url}
          title={pdfPreview.title}
          onClose={() => setPdfPreview(null)}
          onOpenExternal={() => {
            void api.openPath(pdfPreview.path).catch((e) => {
              setGeoError(e instanceof Error ? e.message : String(e));
            });
          }}
        />
      )}
    </div>
  );
}
