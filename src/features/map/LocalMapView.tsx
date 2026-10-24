import { useEffect, useRef } from "react";
import maplibregl, {
  type GeoJSONSource,
  type Map as MlMap,
  type Marker,
  type StyleSpecification,
  type SymbolLayerSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { UserMarker, WaterPoint } from "../../shared/types";
import type { SearchPin } from "./YandexMapView";

const HOUSE_MIN_ZOOM = 16;
const MAP_MAX_ZOOM = 19;
const OPENFREEMAP_STYLE = "https://tiles.openfreemap.org/styles/liberty";

const HOUSE_LAYOUT: SymbolLayerSpecification["layout"] = {
  "text-field": ["to-string", ["get", "housenumber"]],
  "text-font": ["Noto Sans Regular"],
  "text-size": ["interpolate", ["linear"], ["zoom"], 16, 10, 19, 13],
  "text-padding": 2,
  "text-optional": true,
  "text-allow-overlap": false,
  "text-ignore-placement": false,
};

const HOUSE_PAINT: SymbolLayerSpecification["paint"] = {
  "text-color": "#334155",
  "text-halo-color": "#ffffff",
  "text-halo-width": 1.1,
};

interface TilePack {
  path: string;
  minZoom: number;
  maxZoom: number;
}

function glyphsUrl(): string {
  return `${window.location.origin}/fonts/{fontstack}/{range}.pbf`;
}

function fileUrl(root: string, ...parts: string[]): string {
  const base = root.replace(/[/\\]+$/, "");
  const sep = base.includes("\\") ? "\\" : "/";
  return convertFileSrc([base, ...parts].join(sep));
}

function addHouseNumberLayer(map: MlMap, id: string, source: string, sourceLayer?: string) {
  if (map.getLayer(id)) return;
  map.addLayer({
    id,
    type: "symbol",
    source,
    ...(sourceLayer ? { "source-layer": sourceLayer } : {}),
    minzoom: HOUSE_MIN_ZOOM,
    layout: HOUSE_LAYOUT,
    paint: HOUSE_PAINT,
  });
}

function addLocalHouseNumberSources(map: MlMap, packs: TilePack[]) {
  packs.forEach((_, i) => {
    const sourceId = `omtiles${i}`;
    if (!map.getSource(sourceId)) {
      map.addSource(sourceId, {
        type: "vector",
        tiles: [`fa-omtile://${i}/{z}/{x}/{y}`],
        minzoom: 14,
        maxzoom: 14,
      });
    }
    addHouseNumberLayer(map, `house-numbers-${i}`, sourceId, "housenumber");
  });
}

function tryOpenFreeMapNumbers(map: MlMap) {
  try {
    if (!map.getSource("openmaptiles")) {
      map.addSource("openmaptiles", {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
      });
    }
    addHouseNumberLayer(map, "house-numbers", "openmaptiles", "housenumber");
  } catch {
    /* offline — номера останутся из локального JSON */
  }
}

function emptyFc(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

function waterCollection(points: WaterPoint[]): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: points.map((p) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
      properties: { id: p.id, name: p.name, water_type: p.water_type, focused: false },
    })),
  };
}

function htmlDot(color: string, size: number, ring = false): HTMLDivElement {
  const el = document.createElement("div");
  el.style.width = `${size}px`;
  el.style.height = `${size}px`;
  el.style.borderRadius = "50%";
  el.style.background = color;
  el.style.border = "2px solid #fff";
  el.style.boxShadow = ring
    ? `0 0 0 6px ${color}55, 0 1px 4px rgba(0,0,0,.45)`
    : "0 1px 4px rgba(0,0,0,.45)";
  return el;
}

interface Props {
  packagePath: string;
  packages?: TilePack[];
  nativeMinZoom?: number;
  nativeMaxZoom?: number;
  center: [number, number];
  zoom: number;
  points: WaterPoint[];
  focusId: number | null;
  searchPin?: SearchPin | null;
  markers?: UserMarker[];
  pickMode?: boolean;
  onPick?: (lat: number, lon: number) => void;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function LocalMapView({
  packagePath,
  packages = [],
  nativeMinZoom = 12,
  nativeMaxZoom = 14,
  center,
  zoom,
  points,
  focusId,
  searchPin = null,
  markers = [],
  pickMode = false,
  onPick,
  onBoundsChange,
  onPointClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MlMap | null>(null);
  const packsRef = useRef<TilePack[]>([]);
  const pointsRef = useRef(points);
  const focusIdRef = useRef(focusId);
  const pickModeRef = useRef(pickMode);
  const onPickRef = useRef(onPick);
  const onPointClickRef = useRef(onPointClick);
  const onBoundsRef = useRef(onBoundsChange);
  const pinMarkerRef = useRef<Marker | null>(null);
  const userMarkersRef = useRef<Marker[]>([]);
  const lastCenterRef = useRef<[number, number]>(center);

  const tilePacks: TilePack[] =
    packages.length > 0
      ? packages
      : packagePath
        ? [{ path: packagePath, minZoom: nativeMinZoom, maxZoom: nativeMaxZoom }]
        : [];

  packsRef.current = tilePacks;
  pointsRef.current = points;
  focusIdRef.current = focusId;
  pickModeRef.current = pickMode;
  onPickRef.current = onPick;
  onPointClickRef.current = onPointClick;
  onBoundsRef.current = onBoundsChange;

  const packsKey = tilePacks.map((p) => p.path).join("|");

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const packs = packsRef.current;
    const localGlyphs = glyphsUrl();
    const style: string | StyleSpecification = packs.length
      ? {
          version: 8 as const,
          glyphs: localGlyphs,
          sources: Object.fromEntries([
            ...packs.map((pack, i) => [
              `pack${i}`,
              {
                type: "raster" as const,
                tiles: [`fa-tile://${i}/{z}/{x}/{y}`],
                tileSize: 256,
                minzoom: pack.minZoom,
                maxzoom: pack.maxZoom,
                attribution: "© OpenStreetMap / Esri",
              },
            ]),
            [
              "water",
              {
                type: "geojson" as const,
                data: emptyFc(),
                cluster: true,
                clusterMaxZoom: 17,
                clusterRadius: 48,
              },
            ],
          ]),
          layers: [
            { id: "background", type: "background", paint: { "background-color": "#e8e0d4" } },
            ...packs.map((_, i) => ({
              id: `pack${i}`,
              type: "raster" as const,
              source: `pack${i}`,
            })),
          ],
        }
      : OPENFREEMAP_STYLE;

    const map = new maplibregl.Map({
      container: host,
      style,
      center: [center[1], center[0]],
      zoom: Math.min(Math.max(zoom, 2), MAP_MAX_ZOOM),
      minZoom: packs.length ? Math.max(1, Math.min(...packs.map((p) => p.minZoom)) - 2) : 2,
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: { compact: true },
      fadeDuration: 0,
      transformRequest: (url) => {
        if (url.startsWith("fa-omtile://")) {
          const [idx, z, x, yWithQ] = url.slice("fa-omtile://".length).split("/");
          const y = (yWithQ || "").split("?")[0].replace(/\.pbf$/i, "");
          const pack = packsRef.current[Number(idx)];
          if (!pack) return { url: "" };
          return { url: fileUrl(pack.path, "omtiles", z, x, `${y}.pbf`), type: "arrayBuffer" };
        }
        if (!url.startsWith("fa-tile://")) return { url };
        const [idx, z, x, yWithQ] = url.slice("fa-tile://".length).split("/");
        const y = (yWithQ || "").split("?")[0].replace(/\.png$/i, "");
        const pack = packsRef.current[Number(idx)];
        if (!pack) return { url: "" };
        return { url: fileUrl(pack.path, z, x, `${y}.png`) };
      },
    });
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    mapRef.current = map;

    const emitBounds = () => {
      const b = map.getBounds();
      onBoundsRef.current({
        south: b.getSouth(),
        west: b.getWest(),
        north: b.getNorth(),
        east: b.getEast(),
      });
    };

    const onLoad = () => {
      if (packs.length) {
        addLocalHouseNumberSources(map, packs);
      } else {
        tryOpenFreeMapNumbers(map);
      }
      if (!map.getSource("water")) {
        map.addSource("water", {
          type: "geojson",
          data: emptyFc(),
          cluster: true,
          clusterMaxZoom: 17,
          clusterRadius: 48,
        });
      }
      if (!map.getLayer("water-clusters")) {
        map.addLayer({
          id: "water-clusters",
          type: "circle",
          source: "water",
          filter: ["has", "point_count"],
          paint: {
            "circle-color": "#c45a2a",
            "circle-radius": ["step", ["get", "point_count"], 16, 10, 20, 50, 26],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
        map.addLayer({
          id: "water-cluster-count",
          type: "symbol",
          source: "water",
          filter: ["has", "point_count"],
          layout: {
            "text-field": ["to-string", ["get", "point_count_abbreviated"]],
            "text-font": ["Noto Sans Regular"],
            "text-size": 12,
          },
          paint: { "text-color": "#ffffff" },
        });
        map.addLayer({
          id: "water-points",
          type: "circle",
          source: "water",
          filter: ["!", ["has", "point_count"]],
          paint: {
            "circle-color": [
              "match",
              ["get", "water_type"],
              "hydrant",
              "#e74c3c",
              "pond",
              "#3498db",
              "tower",
              "#f39c12",
              "pier",
              "#1abc9c",
              "#95a5a6",
            ],
            "circle-radius": ["case", ["==", ["get", "id"], focusIdRef.current ?? -1], 9, 7],
            "circle-stroke-width": 2,
            "circle-stroke-color": "#ffffff",
          },
        });
      }

      const src = map.getSource("water") as GeoJSONSource | undefined;
      src?.setData(waterCollection(pointsRef.current));
      emitBounds();
    };

    map.on("load", onLoad);
    map.on("moveend", emitBounds);
    map.on("click", (e) => {
      if (pickModeRef.current) onPickRef.current?.(e.lngLat.lat, e.lngLat.lng);
    });
    map.on("click", "water-points", (e) => {
      e.preventDefault();
      const id = Number(e.features?.[0]?.properties?.id);
      const point = pointsRef.current.find((p) => p.id === id);
      if (!point) return;
      if (pickModeRef.current) onPickRef.current?.(point.lat, point.lon);
      else onPointClickRef.current(point);
    });
    map.on("click", "water-clusters", (e) => {
      e.preventDefault();
      const feature = e.features?.[0];
      const clusterId = feature?.properties?.cluster_id;
      const src = map.getSource("water") as GeoJSONSource | undefined;
      if (clusterId == null || !src?.getClusterExpansionZoom) return;
      void src.getClusterExpansionZoom(clusterId).then((nextZoom) => {
        if (nextZoom == null || feature?.geometry?.type !== "Point") return;
        const [lng, lat] = feature.geometry.coordinates as [number, number];
        map.easeTo({ center: [lng, lat], zoom: nextZoom });
      });
    });
    map.on("mouseenter", "water-points", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "water-points", () => {
      map.getCanvas().style.cursor = pickModeRef.current ? "crosshair" : "";
    });

    const ro = new ResizeObserver(() => map.resize());
    ro.observe(host);

    return () => {
      ro.disconnect();
      pinMarkerRef.current?.remove();
      pinMarkerRef.current = null;
      for (const m of userMarkersRef.current) m.remove();
      userMarkersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
    // Map is recreated when the set of tile packs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packsKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.isStyleLoaded()) return;
    const src = map.getSource("water") as GeoJSONSource | undefined;
    src?.setData(waterCollection(points));
    if (map.getLayer("water-points")) {
      map.setPaintProperty("water-points", "circle-radius", [
        "case",
        ["==", ["get", "id"], focusId ?? -1],
        9,
        7,
      ]);
    }
  }, [points, focusId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const prev = lastCenterRef.current;
    if (prev[0] === center[0] && prev[1] === center[1] && map.getZoom() >= zoom - 0.05) return;
    lastCenterRef.current = center;
    map.easeTo({
      center: [center[1], center[0]],
      zoom: Math.min(MAP_MAX_ZOOM, Math.max(map.getMinZoom(), zoom)),
      duration: 500,
    });
  }, [center, zoom]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.getCanvas().style.cursor = pickMode ? "crosshair" : "";
  }, [pickMode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    pinMarkerRef.current?.remove();
    pinMarkerRef.current = null;
    if (!searchPin) return;
    const marker = new maplibregl.Marker({ element: htmlDot("#ffcc00", 18, true) })
      .setLngLat([searchPin.lon, searchPin.lat])
      .setPopup(new maplibregl.Popup({ closeButton: false }).setText(searchPin.label))
      .addTo(map);
    marker.togglePopup();
    pinMarkerRef.current = marker;
  }, [searchPin]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    for (const m of userMarkersRef.current) m.remove();
    userMarkersRef.current = markers.map((um) => {
      const popup = um.comment
        ? `<strong>${um.name}</strong><br/>${um.comment}`
        : `<strong>${um.name}</strong>`;
      return new maplibregl.Marker({ element: htmlDot("#9b59b6", 16) })
        .setLngLat([um.lon, um.lat])
        .setPopup(new maplibregl.Popup({ closeButton: false }).setHTML(popup))
        .addTo(map);
    });
  }, [markers]);

  return <div ref={hostRef} className="maplibre-host" />;
}
