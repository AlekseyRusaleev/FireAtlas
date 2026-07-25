import { useEffect, useMemo, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import "leaflet/dist/leaflet.css";
import * as api from "../../shared/api";
import {
  WATER_TYPE_LABELS,
  WATER_TYPE_SHORT,
  type AppSettings,
  type NearbyPoint,
  type SearchHit,
  type WaterPoint,
  type WaterType,
} from "../../shared/types";

// Fix default Leaflet marker paths in Vite
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const ALL_TYPES: WaterType[] = ["hydrant", "pond", "tower", "pier"];

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

function makeIcon(type: WaterType) {
  const color = typeColor(type);
  return L.divIcon({
    className: "",
    html: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });
}

function FlyTo({ center, zoom }: { center: [number, number]; zoom?: number }) {
  const map = useMap();
  useEffect(() => {
    map.flyTo(center, zoom ?? Math.max(map.getZoom(), 15), { duration: 0.6 });
  }, [center, zoom, map]);
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

interface Props {
  settings: AppSettings;
}

export function MapPage({ settings }: Props) {
  const [query, setQuery] = useState("");
  const [types, setTypes] = useState<WaterType[]>([...ALL_TYPES]);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [points, setPoints] = useState<WaterPoint[]>([]);
  const [selected, setSelected] = useState<SearchHit | null>(null);
  const [water, setWater] = useState<WaterPoint | null>(null);
  const [nearby, setNearby] = useState<NearbyPoint[]>([]);
  const [center, setCenter] = useState<[number, number]>([
    settings.default_lat,
    settings.default_lon,
  ]);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [history, setHistory] = useState<SearchHit[]>([]);
  const [favorites, setFavorites] = useState<SearchHit[]>([]);
  const [sideMode, setSideMode] = useState<"search" | "history" | "favorites">("search");

  const enabled = useMemo(() => new Set(types), [types]);

  async function refreshLists() {
    const [h, f] = await Promise.all([api.getHistory(15), api.getFavorites()]);
    setHistory(h);
    setFavorites(f);
  }

  useEffect(() => {
    void refreshLists();
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        if (!query.trim()) {
          setHits([]);
          return;
        }
        const res = await api.search(query, types, 40);
        setHits(res);
      })();
    }, 180);
    return () => window.clearTimeout(t);
  }, [query, types]);

  async function selectHit(hit: SearchHit) {
    setSelected(hit);
    await api.addHistory(hit.kind, hit.id, hit.title);
    void refreshLists();
    if (hit.kind === "water") {
      const wp = await api.getWaterPoint(hit.id);
      setWater(wp);
      if (wp) {
        setCenter([wp.lat, wp.lon]);
        setFocusId(wp.id);
        setNearby(await api.nearby(wp.lat, wp.lon, 8, types));
      }
    } else {
      setWater(null);
      const card = await api.getCard(hit.id);
      if (card?.lat != null && card.lon != null) {
        setCenter([card.lat, card.lon]);
        setNearby(await api.nearby(card.lat, card.lon, 8, types));
      } else {
        setNearby([]);
      }
    }
  }

  function toggleType(t: WaterType) {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));
  }

  return (
    <div className="panel map-layout">
      <aside className="side">
        <input
          id="global-search"
          className="search-box"
          placeholder="Поиск: адрес, название, номер…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSideMode("search");
          }}
        />
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
        </div>
        <div className="filters">
          {ALL_TYPES.map((t) => (
            <label key={t}>
              <input
                type="checkbox"
                checked={enabled.has(t)}
                onChange={() => toggleType(t)}
              />
              {WATER_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
        <div className="results">
          {sideMode === "search" && hits.length === 0 && (
            <div className="empty">
              {query.trim()
                ? "Ничего не найдено"
                : "Введите запрос — единый поиск по ВО и карточкам"}
            </div>
          )}
          {(sideMode === "search" ? hits : sideMode === "history" ? history : favorites).map(
            (hit) => (
              <button
                key={`${sideMode}-${hit.kind}-${hit.id}-${hit.subtitle}`}
                className={`result-item ${selected?.id === hit.id && selected.kind === hit.kind ? "active" : ""}`}
                onClick={() => void selectHit(hit)}
              >
                <div className="title">
                  <span className={`badge ${hit.kind === "card" ? "card" : hit.water_type || ""}`}>
                    {hit.kind === "card"
                      ? "Карточка"
                      : WATER_TYPE_SHORT[hit.water_type || "other"]}
                  </span>
                  {hit.title}
                </div>
                <div className="meta">{hit.subtitle}</div>
              </button>
            )
          )}
          {sideMode === "history" && history.length === 0 && (
            <div className="empty">История пуста</div>
          )}
          {sideMode === "favorites" && favorites.length === 0 && (
            <div className="empty">Нет избранного</div>
          )}
        </div>
      </aside>

      <div className="map-pane">
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
          <FlyTo center={center} />
          <BoundsLoader types={types} onPoints={setPoints} />
          {points.map((p) => (
            <Marker
              key={p.id}
              position={[p.lat, p.lon]}
              icon={makeIcon(p.water_type)}
              opacity={focusId === p.id ? 1 : 0.9}
              eventHandlers={{
                click: () => {
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
                },
              }}
            >
              <Popup>
                <strong>{p.name}</strong>
                <br />
                {WATER_TYPE_SHORT[p.water_type]}
              </Popup>
            </Marker>
          ))}
        </MapContainer>
      </div>

      <aside className="detail">
        {!selected && <div className="empty">Выберите объект на карте или в поиске</div>}
        {selected && (
          <>
            <h2>{selected.title}</h2>
            <dl>
              <div>
                <dt>Тип</dt>
                <dd>
                  {selected.kind === "card"
                    ? "Карточка тушения"
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
              {water?.description && (
                <div>
                  <dt>Описание</dt>
                  <dd>{water.description}</dd>
                </div>
              )}
            </dl>

            <div className="actions">
              {selected.kind === "card" && (
                <button className="btn primary" disabled>
                  Открыть карточку (раздел «Карточки»)
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
                <button
                  className="btn"
                  onClick={() => setCenter([water.lat, water.lon])}
                >
                  Показать на карте
                </button>
              )}
            </div>

            <div>
              <h3 style={{ margin: "0.5rem 0" }}>Ближайшие водоисточники</h3>
              {nearby.length === 0 && (
                <div className="muted">Нет данных поблизости</div>
              )}
              <div className="nearby-list">
                {nearby.map((n) => (
                  <div key={n.id} className="nearby-item">
                    <strong>
                      {WATER_TYPE_SHORT[n.water_type]} · {n.name}
                    </strong>
                    <div className="muted">{Math.round(n.distance_m)} м</div>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
