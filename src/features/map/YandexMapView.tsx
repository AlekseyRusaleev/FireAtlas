/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
import type { WaterPoint, WaterType } from "../../shared/types";

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.ready === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Не удалось загрузить скрипт карты")));
      return;
    }
    const s = document.createElement("script");
    s.id = id;
    s.src = src;
    s.async = true;
    s.onload = () => {
      s.dataset.ready = "1";
      resolve();
    };
    s.onerror = () => reject(new Error(`Не удалось загрузить: ${src}`));
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

interface Props {
  apiKey: string;
  center: [number, number];
  zoom: number;
  points: WaterPoint[];
  focusId: number | null;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function YandexMapView({
  apiKey,
  center,
  zoom,
  points,
  focusId,
  onBoundsChange,
  onPointClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onPointClickRef = useRef(onPointClick);
  onBoundsChangeRef.current = onBoundsChange;
  onPointClickRef.current = onPointClick;

  useEffect(() => {
    let destroyed = false;
    if (!hostRef.current || !apiKey) return;

    void (async () => {
      try {
        await loadScript(
          `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`,
          "yandex-maps-api"
        );
        const ymaps = (window as any).ymaps;
        if (destroyed || !ymaps) return;
        ymaps.ready(() => {
          if (destroyed || !hostRef.current) return;
          const map = new ymaps.Map(hostRef.current, {
            center: [center[0], center[1]],
            zoom,
            controls: ["zoomControl", "typeSelector", "fullscreenControl", "searchControl"],
          });
          mapRef.current = map;

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
              const c = map.getCenter();
              onBoundsChangeRef.current({
                south: c[0] - span / 2,
                north: c[0] + span / 2,
                west: c[1] - span,
                east: c[1] + span,
              });
            }
          };

          map.events.add("boundschange", emitBounds);
          emitBounds();
          map.container.fitToViewport();
        });
      } catch (e) {
        console.error(e);
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
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    map.setCenter([center[0], center[1]], Math.max(map.getZoom(), 15), { duration: 300 });
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    const ymaps = (window as any).ymaps;
    if (!map || !ymaps) return;
    map.geoObjects.removeAll();
    for (const p of points) {
      const pm = new ymaps.Placemark(
        [p.lat, p.lon],
        {
          balloonContentHeader: p.name,
          balloonContentBody: p.address || "",
          hintContent: p.name,
        },
        {
          preset: focusId === p.id ? "islands#redDotIcon" : "islands#blueCircleDotIcon",
          iconColor: typeColor(p.water_type),
        }
      );
      pm.events.add("click", () => onPointClickRef.current(p));
      map.geoObjects.add(pm);
    }
  }, [points, focusId]);

  if (!apiKey) {
    return (
      <div className="empty map-missing-key">
        Для Яндекс.Карт укажите API-ключ в настройках
        <div className="muted" style={{ marginTop: 8 }}>
          Ключ: https://developer.tech.yandex.ru/ — сервис «JavaScript API и HTTP Геокодер»
        </div>
      </div>
    );
  }

  return <div ref={hostRef} className="provider-map" />;
}
