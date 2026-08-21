import { useEffect, useRef } from "react";
import { MapContainer, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { convertFileSrc } from "@tauri-apps/api/core";
import "leaflet/dist/leaflet.css";
import type { WaterPoint } from "../../shared/types";
import type { SearchPin } from "./YandexMapView";
import { HouseNumbersLayer } from "./HouseNumbersLayer";
import { WaterClusterLayer } from "./WaterClusterLayer";

const VIEW_MIN_ZOOM = 4;
const VIEW_MAX_ZOOM = 20;

/** Геометрия без подписей — если OSM не открылся, латиницы всё равно нет. */
const GEOMETRY_URL =
  "https://{s}.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png";

/** OSM Carto (HOT): в России в тайле поле name — кириллица, без транслита Carto/Esri. */
const OSM_LOCAL_URL = "https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png";

const TRANSPARENT_TILE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const SEARCH_PIN_ICON = L.divIcon({
  className: "",
  html: `<div style="width:22px;height:22px;border-radius:50%;background:#ffcc00;border:3px solid #fff;box-shadow:0 0 0 6px rgba(255,204,0,.35),0 2px 8px rgba(0,0,0,.45)"></div>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

function BasemapLayers({
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
    const geometry = L.tileLayer(GEOMETRY_URL, {
      subdomains: "abcd",
      minZoom: 1,
      maxZoom: VIEW_MAX_ZOOM,
      maxNativeZoom: 20,
      attribution: "&copy; OpenStreetMap",
    });
    geometry.addTo(map);

    let local: L.TileLayer | null = null;
    if (packagePath) {
      const root = packagePath.replace(/[/\\]+$/, "");
      const sep = root.includes("\\") ? "\\" : "/";
      const Layer = L.TileLayer.extend({
        getTileUrl(coords: L.Coords) {
          const tilePath = `${root}${sep}${coords.z}${sep}${coords.x}${sep}${coords.y}.png`;
          return convertFileSrc(tilePath);
        },
      });
      local = new (Layer as unknown as typeof L.TileLayer)("", {
        minZoom: nativeMinZoom,
        maxZoom: nativeMaxZoom,
        minNativeZoom: nativeMinZoom,
        maxNativeZoom: nativeMaxZoom,
        attribution: "&copy; OpenStreetMap",
        errorTileUrl: TRANSPARENT_TILE,
      });
      local.addTo(map);
    }

    const labels = L.tileLayer(OSM_LOCAL_URL, {
      subdomains: "abc",
      minZoom: 1,
      maxZoom: VIEW_MAX_ZOOM,
      maxNativeZoom: 19,
      attribution: "&copy; OpenStreetMap",
      errorTileUrl: TRANSPARENT_TILE,
    });
    labels.addTo(map);

    return () => {
      map.removeLayer(labels);
      if (local) map.removeLayer(local);
      map.removeLayer(geometry);
    };
  }, [map, packagePath, nativeMinZoom, nativeMaxZoom]);
  return null;
}

function FlyTo({
  center,
  zoom,
  nonce = 0,
}: {
  center: [number, number];
  zoom: number;
  nonce?: number;
}) {
  const map = useMap();
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  useEffect(() => {
    map.invalidateSize();
    map.setView(center, Math.max(map.getZoom(), zoomRef.current), {
      animate: true,
      duration: 0.2,
    });
  }, [center[0], center[1], nonce, map]);
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
  pickMode,
  onPointClick,
  onPick,
}: {
  points: WaterPoint[];
  focusId: number | null;
  pickMode: boolean;
  onPointClick: (p: WaterPoint) => void;
  onPick?: (lat: number, lon: number) => void;
}) {
  return (
    <WaterClusterLayer
      points={points}
      focusId={focusId}
      pickMode={pickMode}
      onPointClick={onPointClick}
      onPick={onPick}
    />
  );
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

const USER_MARKER_ICON = L.divIcon({
  className: "",
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#9b59b6;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

function MapClickCatcher({
  enabled,
  onPick,
}: {
  enabled: boolean;
  onPick: (lat: number, lon: number) => void;
}) {
  const map = useMapEvents({
    click: (e) => {
      if (enabled) onPick(e.latlng.lat, e.latlng.lng);
    },
  });
  useEffect(() => {
    const el = map.getContainer();
    const prev = el.style.cursor;
    el.style.cursor = enabled ? "crosshair" : "";
    return () => {
      el.style.cursor = prev;
    };
  }, [map, enabled]);
  return null;
}

function UserMarkersLayer({
  markers,
}: {
  markers: Array<{ id: number; name: string; comment: string | null; lat: number; lon: number }>;
}) {
  const map = useMap();
  useEffect(() => {
    const group = L.layerGroup().addTo(map);
    for (const m of markers) {
      const marker = L.marker([m.lat, m.lon], {
        icon: USER_MARKER_ICON,
        zIndexOffset: 500,
      });
      const body = m.comment
        ? `<strong>${m.name}</strong><br/>${m.comment}`
        : `<strong>${m.name}</strong>`;
      marker.bindPopup(body);
      marker.addTo(group);
    }
    return () => {
      map.removeLayer(group);
    };
  }, [map, markers]);
  return null;
}

interface Props {
  packagePath?: string;
  nativeMinZoom?: number;
  nativeMaxZoom?: number;
  center: [number, number];
  zoom: number;
  focusNonce?: number;
  points: WaterPoint[];
  focusId: number | null;
  searchPin?: SearchPin | null;
  markers?: Array<{ id: number; name: string; comment: string | null; lat: number; lon: number }>;
  pickMode?: boolean;
  onPick?: (lat: number, lon: number) => void;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function LocalMapView({
  packagePath = "",
  nativeMinZoom = 12,
  nativeMaxZoom = 14,
  center,
  zoom,
  focusNonce = 0,
  points,
  focusId,
  searchPin = null,
  markers = [],
  pickMode = false,
  onPick,
  onBoundsChange,
  onPointClick,
}: Props) {
  const initialZoom = Math.min(Math.max(zoom, VIEW_MIN_ZOOM), VIEW_MAX_ZOOM);

  return (
    <MapContainer
      center={center}
      zoom={initialZoom}
      minZoom={VIEW_MIN_ZOOM}
      maxZoom={VIEW_MAX_ZOOM}
      zoomControl
      style={{ width: "100%", height: "100%" }}
    >
      <BasemapLayers
        packagePath={packagePath}
        nativeMinZoom={nativeMinZoom}
        nativeMaxZoom={nativeMaxZoom}
      />
      <FlyTo
        center={center}
        zoom={Math.min(Math.max(zoom, VIEW_MIN_ZOOM), VIEW_MAX_ZOOM)}
        nonce={focusNonce}
      />
      <BoundsWatcher onBounds={onBoundsChange} />
      <MapClickCatcher
        enabled={pickMode}
        onPick={(lat, lon) => onPick?.(lat, lon)}
      />
      <MarkersLayer
        points={points}
        focusId={focusId}
        pickMode={pickMode}
        onPointClick={onPointClick}
        onPick={onPick}
      />
      <UserMarkersLayer markers={markers} />
      <SearchPinLayer searchPin={searchPin} />
      <HouseNumbersLayer />
    </MapContainer>
  );
}
