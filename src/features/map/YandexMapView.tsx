/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import type { UserMarker, WaterPoint, WaterType } from "../../shared/types";

const SCRIPT_ID = "yandex-maps-api";

function yandexScriptSrc(apiKey: string): string {
  return `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
}

/** Перезагружает скрипт, если ключ сменился — иначе старый apikey остаётся в памяти. */
function loadYandexScript(apiKey: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.key === apiKey && existing.dataset.ready === "1" && (window as any).ymaps) {
        resolve();
        return;
      }
      existing.remove();
      try {
        delete (window as any).ymaps;
      } catch {
        (window as any).ymaps = undefined;
      }
    }

    const s = document.createElement("script");
    s.id = SCRIPT_ID;
    s.src = yandexScriptSrc(apiKey);
    s.async = true;
    s.dataset.key = apiKey;
    s.onload = () => {
      s.dataset.ready = "1";
      resolve();
    };
    s.onerror = () =>
      reject(
        new Error(
          "Не удалось загрузить скрипт Яндекс.Карт. Проверьте интернет и ключ на developer.tech.yandex.ru."
        )
      );
    document.head.appendChild(s);
  });
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

export interface SearchPin {
  lat: number;
  lon: number;
  label: string;
}

interface Props {
  apiKey: string;
  center: [number, number];
  zoom: number;
  /** Минимальный зум при переносе карты: для найденного адреса нужен крупный масштаб. */
  focusZoom?: number;
  points: WaterPoint[];
  focusId: number | null;
  searchPin?: SearchPin | null;
  markers?: UserMarker[];
  pickMode?: boolean;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
  onMapPick?: (lat: number, lon: number) => void;
  onMarkerClick?: (marker: UserMarker) => void;
}

export function YandexMapView({
  apiKey,
  center,
  zoom,
  focusZoom = 15,
  points,
  focusId,
  searchPin = null,
  markers = [],
  pickMode = false,
  onBoundsChange,
  onPointClick,
  onMapPick,
  onMarkerClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [mapReady, setMapReady] = useState(false);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(
    apiKey ? "loading" : "idle"
  );
  const [error, setError] = useState<string | null>(null);
  const mapRef = useRef<any>(null);
  const objectManagerRef = useRef<any>(null);
  const pointsByIdRef = useRef<Map<number, WaterPoint>>(new Map());
  const focusIdRef = useRef(focusId);
  const pinLayerRef = useRef<any>(null);
  const markersLayerRef = useRef<any>(null);
  const cursorRef = useRef<any>(null);
  focusIdRef.current = focusId;
  const centerRef = useRef(center);
  const focusZoomRef = useRef(focusZoom);
  const pickModeRef = useRef(pickMode);
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onPointClickRef = useRef(onPointClick);
  const onMapPickRef = useRef(onMapPick);
  const onMarkerClickRef = useRef(onMarkerClick);
  centerRef.current = center;
  focusZoomRef.current = focusZoom;
  pickModeRef.current = pickMode;
  onBoundsChangeRef.current = onBoundsChange;
  onPointClickRef.current = onPointClick;
  onMapPickRef.current = onMapPick;
  onMarkerClickRef.current = onMarkerClick;

  useEffect(() => {
    let destroyed = false;
    setMapReady(false);

    if (!apiKey) {
      setStatus("idle");
      setError(null);
      return;
    }

    setStatus("loading");
    setError(null);

    void (async () => {
      try {
        await loadYandexScript(apiKey);
        const ymaps = (window as any).ymaps;
        if (destroyed || !ymaps) {
          if (!destroyed) {
            setStatus("error");
            setError("Скрипт Яндекс.Карт загрузился, но API недоступен. Проверьте ключ.");
          }
          return;
        }

        ymaps.ready(
          () => {
            if (destroyed || !hostRef.current) return;
            try {
              const c = centerRef.current;
              const map = new ymaps.Map(hostRef.current, {
                center: [c[0], c[1]],
                zoom,
                controls: ["zoomControl", "typeSelector", "fullscreenControl"],
              });
              mapRef.current = map;

              // ObjectManager + кластеры: тысячи Placemark подвисают UI.
              const objectManager = new ymaps.ObjectManager({
                clusterize: true,
                gridSize: 64,
                clusterDisableClickZoom: false,
              });
              objectManager.objects.options.set("preset", "islands#blueCircleDotIcon");
              objectManager.clusters.options.set("preset", "islands#invertedBlueClusterIcons");
              objectManager.objects.events.add("click", (e: any) => {
                const id = Number(e.get("objectId"));
                const point = pointsByIdRef.current.get(id);
                if (point) onPointClickRef.current(point);
              });
              map.geoObjects.add(objectManager);
              objectManagerRef.current = objectManager;

              pinLayerRef.current = new ymaps.GeoObjectCollection();
              markersLayerRef.current = new ymaps.GeoObjectCollection();
              map.geoObjects.add(markersLayerRef.current);
              map.geoObjects.add(pinLayerRef.current);
              setMapReady(true);
              setStatus("ready");

              const emitBounds = () => {
                try {
                  const b = map.getBounds();
                  onBoundsChangeRef.current({
                    south: b[0][0],
                    west: b[0][1],
                    north: b[1][0],
                    east: b[1][1],
                  });
                } catch {
                  const z = map.getZoom();
                  const span = 360 / Math.pow(2, z);
                  const mc = map.getCenter();
                  onBoundsChangeRef.current({
                    south: mc[0] - span / 2,
                    north: mc[0] + span / 2,
                    west: mc[1] - span,
                    east: mc[1] + span,
                  });
                }
              };

              map.events.add("boundschange", emitBounds);
              map.events.add("click", (e: any) => {
                if (!pickModeRef.current) return;
                const coords = e.get("coords");
                if (coords) onMapPickRef.current?.(Number(coords[0]), Number(coords[1]));
              });
              emitBounds();
              map.container.fitToViewport();
            } catch (e) {
              if (destroyed) return;
              setStatus("error");
              setError(
                `Карта не создалась: ${e instanceof Error ? e.message : String(e)}. Проверьте ключ сервиса «JavaScript API и HTTP Геокодер».`
              );
            }
          },
          (err: unknown) => {
            if (destroyed) return;
            setStatus("error");
            setError(
              `Яндекс.Карты отклонили ключ: ${err instanceof Error ? err.message : String(err)}. Нужен сервис «JavaScript API и HTTP Геокодер» без жёсткого ограничения по сайту.`
            );
          }
        );
      } catch (e) {
        if (destroyed) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      destroyed = true;
      try {
        mapRef.current?.destroy();
      } catch {
        /* ignore */
      }
      mapRef.current = null;
      objectManagerRef.current = null;
      pointsByIdRef.current = new Map();
      pinLayerRef.current = null;
      markersLayerRef.current = null;
      cursorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setCenter([center[0], center[1]], Math.max(map.getZoom(), focusZoomRef.current), {
      duration: 300,
    });
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map?.cursors) return;
    if (pickMode) {
      cursorRef.current = map.cursors.push("crosshair");
    } else {
      cursorRef.current?.remove();
      cursorRef.current = null;
    }
  }, [pickMode, mapReady]);

  useEffect(() => {
    const objectManager = objectManagerRef.current;
    const ymaps = (window as any).ymaps;
    if (!objectManager || !ymaps || !mapReady) return;

    const byId = new Map<number, WaterPoint>();
    const features = points.map((p) => {
      byId.set(p.id, p);
      return {
        type: "Feature",
        id: p.id,
        geometry: { type: "Point", coordinates: [p.lat, p.lon] },
        properties: {
          balloonContentHeader: p.name,
          balloonContentBody: p.address || "",
          hintContent: p.name,
        },
        options: {
          preset:
            focusIdRef.current === p.id ? "islands#redDotIcon" : "islands#blueCircleDotIcon",
          iconColor: typeColor(p.water_type),
        },
      };
    });
    pointsByIdRef.current = byId;
    objectManager.removeAll();
    objectManager.add({ type: "FeatureCollection", features });
  }, [points, mapReady]);

  // Подсветка выбранной точки без полной перерисовки тысяч меток.
  useEffect(() => {
    const objectManager = objectManagerRef.current;
    if (!objectManager || !mapReady) return;
    for (const p of pointsByIdRef.current.values()) {
      try {
        objectManager.objects.setObjectOptions(p.id, {
          preset: focusId === p.id ? "islands#redDotIcon" : "islands#blueCircleDotIcon",
          iconColor: typeColor(p.water_type),
        });
      } catch {
        /* объект мог уйти при смене viewport */
      }
    }
  }, [focusId, mapReady]);

  useEffect(() => {
    const layer = markersLayerRef.current;
    const ymaps = (window as any).ymaps;
    if (!layer || !ymaps) return;
    layer.removeAll();
    for (const m of markers) {
      const pm = new ymaps.Placemark(
        [m.lat, m.lon],
        {
          balloonContentHeader: m.name,
          balloonContentBody: m.comment || "Моя метка",
          hintContent: m.name,
        },
        { preset: "islands#violetCircleDotIconWithCaption", iconCaption: m.name }
      );
      pm.events.add("click", () => onMarkerClickRef.current?.(m));
      layer.add(pm);
    }
  }, [markers, mapReady]);

  useEffect(() => {
    const layer = pinLayerRef.current;
    const ymaps = (window as any).ymaps;
    if (!layer || !ymaps) return;
    layer.removeAll();
    if (!searchPin) return;

    const halo = new ymaps.Circle(
      [[searchPin.lat, searchPin.lon], 45],
      {},
      {
        fillColor: "#ffcc0033",
        strokeColor: "#ffcc00",
        strokeWidth: 2,
        zIndex: 900,
      }
    );
    const pin = new ymaps.Placemark(
      [searchPin.lat, searchPin.lon],
      {
        balloonContentHeader: "Найденный адрес",
        balloonContentBody: searchPin.label,
        hintContent: searchPin.label,
        iconCaption: searchPin.label,
      },
      {
        preset: "islands#yellowDotIconWithCaption",
        zIndex: 1000,
      }
    );
    layer.add(halo);
    layer.add(pin);
    try {
      pin.balloon.open();
    } catch {
      /* балун не критичен */
    }
  }, [searchPin, mapReady]);

  if (!apiKey) {
    return (
      <div className="empty map-missing-key">
        Для Яндекс.Карт укажите API-ключ в настройках и нажмите «Сохранить»
        <div className="muted" style={{ marginTop: 8 }}>
          Ключ: https://developer.tech.yandex.ru/ — сервис «JavaScript API и HTTP Геокодер»
        </div>
      </div>
    );
  }

  return (
    <div className="provider-map-wrap">
      <div ref={hostRef} className="provider-map" />
      {status === "loading" && (
        <div className="map-overlay">
          Загрузка Яндекс.Карт…
          <div className="muted" style={{ marginTop: 8 }}>
            Ключ: {apiKey.slice(0, 8)}…
          </div>
        </div>
      )}
      {status === "error" && error && (
        <div className="map-overlay error">
          {error}
          <div className="muted" style={{ marginTop: 8 }}>
            Временно можно выбрать OpenStreetMap в настройках — карта заработает без ключа.
          </div>
        </div>
      )}
    </div>
  );
}
