import { useEffect } from "react";
import { MapContainer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import "leaflet/dist/leaflet.css";
import type { WaterPoint, WaterType } from "../../shared/types";
import type { SearchPin } from "./YandexMapView";

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

function makeIcon(type: WaterType, focus: boolean) {
  const color = typeColor(type);
  const size = focus ? 16 : 12;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

const SEARCH_PIN_ICON = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;border-radius:50%;background:#ffcc00;border:3px solid #fff;box-shadow:0 0 0 6px rgba(255,204,0,.35),0 2px 8px rgba(0,0,0,.45)"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function LocalTiles({
  packagePath,
  nativeMinZoom,
  nativeMaxZoom,
}: {
  packagePath: string;
  nativeMinZoom: number;
  nativeMaxZoom: number;
}) {
  const map = useMap();
  useEffect(() => {
    const root = packagePath.replace(/[/\\]+$/, "");
    const sep = root.includes("\\") ? "\\" : "/";
    const Layer = L.TileLayer.extend({
      getTileUrl(coords: L.Coords) {
        const tilePath = `${root}${sep}${coords.z}${sep}${coords.x}${sep}${coords.y}.png`;
        return convertFileSrc(tilePath);
      },
    });
    const local = new (Layer as unknown as typeof L.TileLayer)("", {
      minZoom: 1,
      maxZoom: 22,
      minNativeZoom: nativeMinZoom,
      maxNativeZoom: nativeMaxZoom,
      attribution: "&copy; OpenStreetMap / Carto",
      errorTileUrl:
        "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    });
    local.addTo(map);

    // При сильном приближении подтягиваем онлайн-тайлы с крупными подписями (если есть сеть).
    const online = L.tileLayer(
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_labels_under/{z}/{x}/{y}.png",
      {
        subdomains: "abcd",
        minZoom: nativeMaxZoom + 1,
        maxZoom: 20,
        maxNativeZoom: 20,
        attribution: "&copy; OpenStreetMap, &copy; Carto",
        opacity: 1,
      }
    );
    online.addTo(map);

    return () => {
      map.removeLayer(local);
      map.removeLayer(online);
    };
  }, [map, packagePath, nativeMinZoom, nativeMaxZoom]);
  return null;
}

function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    // invalidateSize помогает, если панель только что обновилась
    map.invalidateSize();
    map.setView(center, zoom, { animate: true });
  }, [center[0], center[1], zoom, map]);
  return null;
}

function BoundsWatcher({
  onBounds,
}: {
  onBounds: (b: { south: number; west: number; north: number; east: number }) => void;
}) {
  const map = useMapEvents({
    moveend: () => {
      const b = map.getBounds();
      onBounds({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      });
    },
    zoomend: () => {
      const b = map.getBounds();
      onBounds({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      });
    },
  });
  useEffect(() => {
    const b = map.getBounds();
    onBounds({
      south: b.getSouth(),
      west: b.getWest(),
      north: b.getNorth(),
      east: b.getEast(),
    });
  }, [map, onBounds]);
  return null;
}

function MarkersLayer({
  points,
  focusId,
  onPointClick,
}: {
  points: WaterPoint[];
  focusId: number | null;
  onPointClick: (p: WaterPoint) => void;
}) {
  const map = useMap();
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    for (const p of points) {
      const m = L.marker([p.lat, p.lon], {
        icon: makeIcon(p.water_type, focusId === p.id),
      });
      m.on("click", () => onPointClick(p));
      m.bindTooltip(p.name);
      m.addTo(group);
    }
    return () => {
      map.removeLayer(group);
    };
  }, [map, points, focusId, onPointClick]);
  return null;
}

function SearchPinLayer({ searchPin }: { searchPin: SearchPin | null }) {
  const map = useMap();
  useEffect(() => {
    if (!searchPin) return;
    const group = L.layerGroup().addTo(map);
    L.circle([searchPin.lat, searchPin.lon], {
      radius: 45,
      color: "#ffcc00",
      weight: 2,
      fillColor: "#ffcc00",
      fillOpacity: 0.2,
    }).addTo(group);
    const marker = L.marker([searchPin.lat, searchPin.lon], {
      icon: SEARCH_PIN_ICON,
      zIndexOffset: 1000,
    });
    marker.bindPopup(`<strong>${searchPin.label}</strong>`).addTo(group);
    marker.openPopup();
    return () => {
      map.removeLayer(group);
    };
  }, [map, searchPin]);
  return null;
}

interface Props {
  packagePath: string;
  nativeMinZoom?: number;
  nativeMaxZoom?: number;
  center: [number, number];
  zoom: number;
  points: WaterPoint[];
  focusId: number | null;
  searchPin?: SearchPin | null;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function LocalMapView({
  packagePath,
  nativeMinZoom = 12,
  nativeMaxZoom = 14,
  center,
  zoom,
  points,
  focusId,
  searchPin = null,
  onBoundsChange,
  onPointClick,
}: Props) {
  if (!packagePath) {
    return (
      <div className="empty map-missing-key">
        Локальная карта не выбрана
        <div className="muted" style={{ marginTop: 8 }}>
          В настройках выберите город и нажмите «Скачать пакет карты» или загрузите готовый ZIP.
        </div>
      </div>
    );
  }

  const viewMin = Math.max(1, nativeMinZoom - 2);
  const viewMax = 19;
  const initialZoom = Math.min(Math.max(zoom, viewMin), viewMax);

  return (
    <MapContainer
      center={center}
      zoom={initialZoom}
      minZoom={viewMin}
      maxZoom={viewMax}
      zoomControl
      style={{ width: "100%", height: "100%" }}
    >
      <LocalTiles
        packagePath={packagePath}
        nativeMinZoom={nativeMinZoom}
        nativeMaxZoom={nativeMaxZoom}
      />
      <FlyTo center={center} zoom={Math.min(Math.max(zoom, viewMin), viewMax)} />
      <BoundsWatcher onBounds={onBoundsChange} />
      <MarkersLayer points={points} focusId={focusId} onPointClick={onPointClick} />
      <SearchPinLayer searchPin={searchPin} />
    </MapContainer>
  );
}
