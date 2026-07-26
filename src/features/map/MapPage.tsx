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
  type MarkerFileInfo,
  type MarkersState,
  type NearbyPoint,
  type SearchHit,
  type UserMarker,
  type WaterPoint,
  type WaterType,
} from "../../shared/types";
import { YandexMapView, type SearchPin } from "./YandexMapView";
import { DgisMapView } from "./DgisMapView";
import { distanceKm, geocodeAddress } from "./geocode";

L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const ALL_TYPES: WaterType[] = ["hydrant", "pond", "tower", "pier", "other"];
const ADDRESS_ZOOM = 17;
/** Поиск адресов и объектов ограничен этим радиусом вокруг города по умолчанию. */
const SEARCH_RADIUS_KM = 50;
/** Сколько точек максимум рисовать на карте за раз — больше сильно подвисает UI. */
const MAP_POINTS_LIMIT = 800;

type SideMode = "search" | "history" | "favorites" | "markers";

function isLikelyAddress(query: string): boolean {
  return (
    /\d/.test(query) ||
    /\b(ул\.?|улица|проспект|пр-т|переулок|пер\.?|шоссе|проезд|бульвар|наб\.?|набережная|дом|д\.)\b/i.test(
      query
    )
  );
}

function typeColor(t: WaterType): string {
  switch (t) {
    case "hydrant":
      return "#e74c3c";
    case "pond":
      return "#3498db";
    case "tower":
      return "#f39c12";
    case "pier":
      return "#1abc9c";
    default:
      return "#95a5a6";
  }
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

function makeIcon(type: WaterType) {
  return dotIcon(typeColor(type), 14);
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
  types,
  onPoints,
}: {
  types: WaterType[];
  onPoints: (points: WaterPoint[]) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      void load();
    },
    zoomend: () => {
      void load();
    },
  });

  async function load() {
    const b = map.getBounds();
    const points = await api.getWaterInBounds(
      b.getSouth(),
      b.getWest(),
      b.getNorth(),
      b.getEast(),
      types
    );
    onPoints(points);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types.join(",")]);

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
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [points, setPoints] = useState<WaterPoint[]>([]);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [water, setWater] = useState<WaterPoint | null>(null);
  const [nearby, setNearby] = useState<NearbyPoint[]>([]);
  const [center, setCenter] = useState<[number, number]>([
    settings.default_lat,
    settings.default_lon,
  ]);
  const [focusZoom, setFocusZoom] = useState(15);
  const [focusId, setFocusId] = useState<number | null>(null);
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
  const [draft, setDraft] = useState<{ lat: number; lon: number } | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftComment, setDraftComment] = useState("");
  const [markerError, setMarkerError] = useState<string | null>(null);
  const draftNameRef = useRef<HTMLInputElement>(null);

  const provider = settings.map_provider || "yandex";
  const sideList =
    sideMode === "search" ? hits : sideMode === "history" ? history : sideMode === "favorites" ? favorites : [];
  const description = useMemo(() => {
    const raw = water?.description;
    if (!raw || !hasReadableText(raw)) return null;
    return sanitizeDescription(raw);
  }, [water?.description]);

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

  useEffect(() => {
    void refreshLists();
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        applyMarkers(await api.listMarkers());
      } catch (e) {
        setMarkerError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [applyMarkers, settings.data_path]);

  useEffect(() => {
    setCenter([settings.default_lat, settings.default_lon]);
  }, [settings.default_lat, settings.default_lon]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        if (!query.trim()) {
          setHits([]);
          // Сброс строки поиска снимает подсветку найденного адреса.
          setSearchPin(null);
          setGeoError(null);
          return;
        }
        const res = await api.search(query, ALL_TYPES, 80);
        // Отсекаем объекты далеко от города по умолчанию (другие регионы в индексе).
        const local = res.filter((hit) => {
          if (hit.lat == null || hit.lon == null) return true;
          return (
            distanceKm(settings.default_lat, settings.default_lon, hit.lat, hit.lon) <=
            SEARCH_RADIUS_KM
          );
        });
        setHits(local.slice(0, 40));
        setActiveIndex(0);
      })();
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, settings.default_lat, settings.default_lon]);

  useEffect(() => {
    setActiveIndex(0);
  }, [sideMode]);

  const loadBounds = useCallback(
    async (b: { south: number; west: number; north: number; east: number }) => {
      const pts = await api.getWaterInBounds(b.south, b.west, b.north, b.east, ALL_TYPES);
      // Лимит на клиенте: даже если БД вернула тысячи точек, на карту кладём урезанный набор.
      setPoints(pts.length > MAP_POINTS_LIMIT ? pts.slice(0, MAP_POINTS_LIMIT) : pts);
    },
    []
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

  async function selectHit(hit: SearchHit) {
    setSelected(hit);
    setGeoError(null);
    // Сразу двигаем карту по координатам из результата (Enter / клик).
    if (hit.lat != null && hit.lon != null) {
      moveTo(hit.lat, hit.lon);
      if (hit.kind === "water") setFocusId(hit.id);
    }
    await api.addHistory(hit.kind, hit.id, hit.title);
    void refreshLists();
    if (hit.kind === "water") {
      const wp = await api.getWaterPoint(hit.id);
      setWater(wp);
      if (wp) {
        moveTo(wp.lat, wp.lon);
        setFocusId(wp.id);
        setNearby(await api.nearby(wp.lat, wp.lon, 8, ALL_TYPES));
      }
    } else {
      setWater(null);
      const card = await api.getCard(hit.id);
      if (card?.lat != null && card.lon != null) {
        moveTo(card.lat, card.lon);
        setNearby(await api.nearby(card.lat, card.lon, 8, ALL_TYPES));
      } else {
        setNearby([]);
      }
    }
  }

  /** Геокодирование: переносим карту на адрес и подсвечиваем его отдельной меткой. */
  async function findAddress(text: string) {
    const q = text.trim();
    if (!q) return;
    setGeoBusy(true);
    setGeoError(null);
    try {
      const found = await geocodeAddress(q, settings.yandex_api_key, {
        lat: settings.default_lat,
        lon: settings.default_lon,
        city: settings.default_city,
        radiusKm: SEARCH_RADIUS_KM,
      });
      setSearchPin(found);
      setSelected(null);
      setWater(null);
      setFocusId(null);
      moveTo(found.lat, found.lon, ADDRESS_ZOOM);
      setNearby(await api.nearby(found.lat, found.lon, 8, ALL_TYPES));
    } catch (e) {
      setSearchPin(null);
      setGeoError(e instanceof Error ? e.message : String(e));
    } finally {
      setGeoBusy(false);
    }
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
      const hit = sideList[activeIndex] ?? sideList[0];
      // Явный адрес геокодируем; объект индекса всегда можно выбрать кликом/стрелками.
      if (sideMode === "search" && (isLikelyAddress(query) || !hit)) {
        void findAddress(query);
      } else if (hit) {
        void selectHit(hit);
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
    setPickMode(false);
    setMarkerError(null);
    setDraft({ lat, lon });
    setDraftName(name);
    setDraftComment("");
    setSideMode("markers");
    window.setTimeout(() => draftNameRef.current?.focus(), 0);
  }

  async function saveDraft() {
    if (!draft) return;
    if (!draftName.trim()) {
      setMarkerError("Укажите название метки");
      draftNameRef.current?.focus();
      return;
    }
    try {
      applyMarkers(
        await api.addMarker(draftName, draftComment.trim() || null, draft.lat, draft.lon)
      );
      setDraft(null);
      setDraftName("");
      setDraftComment("");
    } catch (e) {
      setMarkerError(e instanceof Error ? e.message : String(e));
    }
  }

  async function removeMarker(id: number) {
    try {
      applyMarkers(await api.deleteMarker(id));
    } catch (e) {
      setMarkerError(e instanceof Error ? e.message : String(e));
    }
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

  const mapProps = {
    center,
    zoom: settings.default_zoom,
    focusZoom,
    points,
    focusId,
    searchPin,
    markers,
    pickMode,
    onBoundsChange: onBoundsChangeDebounced,
    onPointClick,
    onMapPick: (lat: number, lon: number) => startDraft(lat, lon),
    onMarkerClick: (m: UserMarker) => {
      setSideMode("markers");
      moveTo(m.lat, m.lon, 16);
    },
  };

  return (
    <div className="panel map-layout">
      <aside className="side">
        <input
          id="global-search"
          className="search-box"
          placeholder={`Адрес в ${settings.default_city || "городе"} (±${SEARCH_RADIUS_KM} км)…`}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSideMode("search");
          }}
          onKeyDown={onSearchKeyDown}
        />
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
            Метки ({markers.length})
          </button>
        </div>

        {sideMode === "markers" ? (
          <div className="results">
            {draft && (
              <div className="marker-form">
                <strong>Новая метка</strong>
                <div className="muted">
                  {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
                </div>
                <input
                  ref={draftNameRef}
                  className="search-box"
                  placeholder="Название метки"
                  value={draftName}
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
                  onChange={(e) => setDraftComment(e.target.value)}
                />
                <div className="actions">
                  <button type="button" className="btn primary" onClick={() => void saveDraft()}>
                    Сохранить
                  </button>
                  <button type="button" className="btn" onClick={() => setDraft(null)}>
                    Отмена
                  </button>
                </div>
              </div>
            )}

            {markerError && (
              <div className="status-banner" style={{ whiteSpace: "pre-wrap" }}>
                {markerError}
              </div>
            )}

            {!draft && markers.length === 0 && (
              <div className="empty">
                Меток пока нет. Нажмите «Поставить метку» на карте и щёлкните по нужному месту.
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
                <button type="button" className="btn" onClick={() => void removeMarker(m.id)}>
                  Удалить
                </button>
              </div>
            ))}

            <div className="muted" style={{ fontSize: "0.8rem" }}>
              {markerFile
                ? `Файл меток: ${markerFile.path}`
                : "Укажите путь к базе в настройках — тогда метки будут дублироваться в KML-файл."}
            </div>
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
                onClick={() => void selectHit(hit)}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <div className="title">
                  <span className={`badge ${hit.kind === "card" ? "card" : hit.water_type || ""}`}>
                    {hit.kind === "card" ? "Карточка" : WATER_TYPE_SHORT[hit.water_type || "other"]}
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
          <button
            type="button"
            className={`btn ${pickMode ? "primary" : ""}`}
            onClick={() => {
              setPickMode((v) => !v);
              setDraft(null);
              setSideMode("markers");
            }}
          >
            {pickMode ? "Отменить метку" : "Поставить метку"}
          </button>
          {pickMode && <span className="map-toolbar-hint">Щёлкните по карте</span>}
        </div>

        {provider === "yandex" && (
          <YandexMapView apiKey={settings.yandex_api_key} {...mapProps} />
        )}
        {provider === "dgis" && <DgisMapView apiKey={settings.dgis_api_key} {...mapProps} />}
        {provider === "osm" && (
          <MapContainer
            center={[settings.default_lat, settings.default_lon]}
            zoom={settings.default_zoom}
            zoomControl
            style={{ width: "100%", height: "100%" }}
          >
            <TileLayer
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
              url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            />
            <FlyTo center={center} zoom={focusZoom} />
            <MapClickCatcher enabled={pickMode} onPick={(lat, lon) => startDraft(lat, lon)} />
            <BoundsLoader types={ALL_TYPES} onPoints={setPoints} />
            {points.map((p) => (
              <Marker
                key={p.id}
                position={[p.lat, p.lon]}
                icon={makeIcon(p.water_type)}
                eventHandlers={{ click: () => onPointClick(p) }}
              >
                <Popup>
                  <strong>{p.name}</strong>
                  <br />
                  {WATER_TYPE_SHORT[p.water_type]}
                </Popup>
              </Marker>
            ))}
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
            <h2>{searchPin.label}</h2>
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
                  {selected.kind === "card"
                    ? "Информационная карточка"
                    : WATER_TYPE_SHORT[selected.water_type || "other"]}
                </dd>
              </div>
              <div>
                <dt>Адрес</dt>
                <dd>{selected.address || water?.address || "—"}</dd>
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
              {water && (
                <button className="btn" onClick={() => moveTo(water.lat, water.lon, 16)}>
                  Показать на карте
                </button>
              )}
            </div>

            <NearbySection nearby={nearby} onSelect={selectNearby} />
          </>
        )}
      </aside>
    </div>
  );
}
