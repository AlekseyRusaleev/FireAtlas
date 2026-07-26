import { useEffect } from "react";
import { MapContainer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import "leaflet/dist/leaflet.css";
import type { WaterPoint, WaterType } from "../../shared/types";

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

function LocalTiles({
  packagePath,
  minZoom,
  maxZoom,
}: {
  packagePath: string;
  minZoom: number;
  maxZoom: number;
}) {
  const map = useMap();
  useEffect(() => {
    const root = packagePath.replace(/[/\\]+$/, "");
    const Layer = L.TileLayer.extend({
      getTileUrl(coords: L.Coords) {
        const tilePath = `${root}${root.includes("\\") ? "\\" : "/"}${coords.z}${
          root.includes("\\") ? "\\" : "/"
        }${coords.x}${root.includes("\\") ? "\\" : "/"}${coords.y}.png`;
        return convertFileSrc(tilePath);
      },
    });
    const layer = new (Layer as unknown as typeof L.TileLayer)("", {
      minZoom,
      maxZoom,
      maxNativeZoom: maxZoom,
      attribution: "&copy; OpenStreetMap",
    });
    layer.addTo(map);
    return () => {
      map.removeLayer(layer);
    };
  }, [map, packagePath, minZoom, maxZoom]);
  return null;
}

function FlyTo({ center, zoom }: { center: [number, number]; zoom: number }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, zoom);
  }, [center, zoom, map]);
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

interface Props {
  packagePath: string;
  minZoom: number;
  maxZoom: number;
  center: [number, number];
  zoom: number;
  points: WaterPoint[];
  focusId: number | null;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function LocalMapView({
  packagePath,
  minZoom,
  maxZoom,
  center,
  zoom,
  points,
  focusId,
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

  return (
    <MapContainer
      center={center}
      zoom={zoom}
      minZoom={minZoom}
      maxZoom={maxZoom}
      zoomControl
      style={{ width: "100%", height: "100%" }}
    >
      <LocalTiles packagePath={packagePath} minZoom={minZoom} maxZoom={maxZoom} />
      <FlyTo center={center} zoom={Math.max(zoom, minZoom)} />
      <BoundsWatcher onBounds={onBoundsChange} />
      <MarkersLayer points={points} focusId={focusId} onPointClick={onPointClick} />
    </MapContainer>
  );
}
