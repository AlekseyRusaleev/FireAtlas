import { useEffect } from "react";
import L from "leaflet";
import { useMap } from "react-leaflet";

const MIN_HOUSE_NUMBER_ZOOM = 15;
const MAX_LABELS = 800;
const CACHE_LIMIT = 24;
const HOUSE_NUMBERS_URL = "https://geo.infocardmchs.ru/housenumbers";

interface HouseLabel {
  id: number;
  number: string;
  lat: number;
  lon: number;
}

interface ApiResponse {
  labels?: Array<{ number?: string; lat?: number; lon?: number }>;
  error?: string;
}

const cache = new Map<string, HouseLabel[]>();

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]!
  );
}

function cacheKey(map: L.Map): string {
  const b = map.getBounds();
  const zoomGroup = Math.min(Math.floor(map.getZoom()), 18);
  return [
    zoomGroup,
    b.getSouth().toFixed(3),
    b.getWest().toFixed(3),
    b.getNorth().toFixed(3),
    b.getEast().toFixed(3),
  ].join(":");
}

/** Крупные номера домов из своего Nominatim (покрытие = импортированные области). */
export function HouseNumbersLayer() {
  const map = useMap();

  useEffect(() => {
    const layer = L.layerGroup([], { pane: "tooltipPane" }).addTo(map);
    const status = new L.Control({ position: "bottomright" });
    let statusNode: HTMLDivElement | null = null;
    status.onAdd = () => {
      statusNode = L.DomUtil.create("div", "house-number-status");
      statusNode.hidden = true;
      return statusNode;
    };
    status.addTo(map);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let currentKey = "";

    function showStatus(message: string | null) {
      if (!statusNode) return;
      statusNode.hidden = !message;
      statusNode.textContent = message || "";
    }

    function draw(labels: HouseLabel[]) {
      layer.clearLayers();
      for (const item of labels) {
        L.marker([item.lat, item.lon], {
          interactive: false,
          keyboard: false,
          icon: L.divIcon({
            className: "house-number-marker",
            html: `<span>${escapeHtml(item.number)}</span>`,
            iconSize: [0, 0],
            iconAnchor: [0, 0],
          }),
        }).addTo(layer);
      }
    }

    async function requestLabels(key: string): Promise<HouseLabel[]> {
      const bounds = map.getBounds().pad(0.04);
      const params = new URLSearchParams({
        south: bounds.getSouth().toFixed(6),
        west: bounds.getWest().toFixed(6),
        north: bounds.getNorth().toFixed(6),
        east: bounds.getEast().toFixed(6),
        limit: String(MAX_LABELS),
      });

      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 15000);
      try {
        const response = await fetch(`${HOUSE_NUMBERS_URL}?${params}`, {
          signal: controller.signal,
          headers: { Accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as ApiResponse;
        if (data.error) throw new Error(data.error);
        const seen = new Set<string>();
        const labels: HouseLabel[] = [];
        for (const item of data.labels || []) {
          const number = String(item.number || "").trim();
          const lat = Number(item.lat);
          const lon = Number(item.lon);
          if (!number || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          const duplicateKey = `${number}:${lat.toFixed(5)}:${lon.toFixed(5)}`;
          if (seen.has(duplicateKey)) continue;
          seen.add(duplicateKey);
          labels.push({ id: labels.length + 1, number, lat, lon });
        }
        cache.set(key, labels);
        while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
        return labels;
      } finally {
        clearTimeout(timeout);
      }
    }

    async function load() {
      if (map.getZoom() < MIN_HOUSE_NUMBER_ZOOM) {
        controller?.abort();
        currentKey = "";
        layer.clearLayers();
        showStatus(null);
        return;
      }

      const key = cacheKey(map);
      if (key === currentKey) return;
      currentKey = key;
      const cached = cache.get(key);
      if (cached) {
        draw(cached);
        showStatus(null);
        return;
      }

      controller?.abort();
      showStatus("Загрузка номеров домов…");
      try {
        const labels = await requestLabels(key);
        if (currentKey !== key) return;
        draw(labels);
        showStatus(labels.length ? null : "Номера домов не найдены");
      } catch {
        if (currentKey === key) showStatus("Номера временно недоступны");
      }
    }

    function scheduleLoad() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void load(), 400);
    }

    map.on("moveend zoomend", scheduleLoad);
    scheduleLoad();
    return () => {
      if (timer) clearTimeout(timer);
      controller?.abort();
      map.off("moveend zoomend", scheduleLoad);
      status.remove();
      map.removeLayer(layer);
    };
  }, [map]);

  return null;
}
