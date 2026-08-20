import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import { Map as MapLibreMap, setWorkerUrl } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";

setWorkerUrl(workerUrl);

/** Те же OSM-улицы, что OpenFreeMap в Infocard. Здесь это подложка ПСЧ, не навигатор. */
export const MAPLIBRE_STYLE_URL = "https://tiles.openfreemap.org/styles/bright";

const OSM_RASTER_URL = "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png";

function hideNativeHouseNumbers(gl: MapLibreMap) {
  for (const layer of gl.getStyle().layers || []) {
    const blob = JSON.stringify(layer);
    if (/housenumber|house-number|house_number/i.test(`${layer.id} ${blob}`)) {
      gl.setLayoutProperty(layer.id, "visibility", "none");
    }
  }
}

/** Векторная OSM-подложка MapLibre; при сбое воркера — растр OSM, чтобы карта не была пустой. */
export function MapLibreBasemap() {
  const map = useMap();

  useEffect(() => {
    const pane = map.getPane("tilePane");
    if (!pane) return;

    const el = L.DomUtil.create("div", "fireatlas-gl-layer", pane);
    el.style.position = "absolute";
    el.style.left = "0";
    el.style.top = "0";
    el.style.zIndex = "0";
    el.style.pointerEvents = "none";

    let gl: MapLibreMap | null = null;
    let raster: L.TileLayer | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;

    function place() {
      const topLeft = map.containerPointToLayerPoint([0, 0]);
      L.DomUtil.setPosition(el, topLeft);
      const size = map.getSize();
      el.style.width = `${Math.max(1, size.x)}px`;
      el.style.height = `${Math.max(1, size.y)}px`;
    }

    function addRaster() {
      if (raster) return;
      raster = L.tileLayer(OSM_RASTER_URL, {
        subdomains: "abcd",
        minZoom: 1,
        maxZoom: 20,
        attribution: "&copy; OpenStreetMap",
      });
      raster.addTo(map);
      raster.bringToBack();
    }

    function fallbackToRaster() {
      if (raster) return;
      el.style.display = "none";
      try {
        gl?.remove();
      } catch {
        /* ignore */
      }
      gl = null;
      addRaster();
    }

    function syncGl() {
      if (!gl) return;
      place();
      const center = map.getCenter();
      gl.resize();
      gl.jumpTo({
        center: [center.lng, center.lat],
        zoom: map.getZoom(),
        bearing: 0,
        pitch: 0,
      });
    }

    place();
    try {
      gl = new MapLibreMap({
        container: el,
        style: MAPLIBRE_STYLE_URL,
        center: [map.getCenter().lng, map.getCenter().lat],
        zoom: map.getZoom(),
        attributionControl: false,
        interactive: false,
        fadeDuration: 0,
      });
    } catch {
      fallbackToRaster();
    }

    if (gl) {
      gl.on("error", () => fallbackToRaster());
      gl.on("load", () => {
        if (gl) hideNativeHouseNumbers(gl);
      });
      fallbackTimer = setTimeout(() => {
        if (gl && !gl.areTilesLoaded()) fallbackToRaster();
      }, 5000);
      map.on("move zoom resize", syncGl);
      syncGl();
    }

    return () => {
      if (fallbackTimer) clearTimeout(fallbackTimer);
      map.off("move zoom resize", syncGl);
      try {
        gl?.remove();
      } catch {
        /* ignore */
      }
      if (raster) map.removeLayer(raster);
      el.remove();
    };
  }, [map]);

  return null;
}
