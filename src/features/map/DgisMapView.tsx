/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef } from "react";
import type { WaterPoint } from "../../shared/types";

function loadScript(src: string, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id) as HTMLScriptElement | null;
    if (existing) {
      if (existing.dataset.ready === "1") {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve());
      existing.addEventListener("error", () => reject(new Error("Не удалось загрузить 2ГИС")));
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

interface Props {
  apiKey: string;
  center: [number, number];
  zoom: number;
  points: WaterPoint[];
  focusId: number | null;
  onBoundsChange: (b: { south: number; west: number; north: number; east: number }) => void;
  onPointClick: (p: WaterPoint) => void;
}

export function DgisMapView({
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
  const markersRef = useRef<any[]>([]);
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onPointClickRef = useRef(onPointClick);
  onBoundsChangeRef.current = onBoundsChange;
  onPointClickRef.current = onPointClick;

  useEffect(() => {
    let destroyed = false;
    if (!apiKey || !hostRef.current) return;

    void (async () => {
      try {
        await loadScript("https://mapgl.2gis.com/api/js/v1", "dgis-mapgl-api");
        const mapgl = (window as any).mapgl;
        if (destroyed || !mapgl || !hostRef.current) return;
        const map = new mapgl.Map(hostRef.current, {
          key: apiKey,
          center: [center[1], center[0]],
          zoom,
          zoomControl: true,
        });
        mapRef.current = map;

        const emit = () => {
          const z = map.getZoom();
          const c = map.getCenter();
          const span = 360 / Math.pow(2, z);
          onBoundsChangeRef.current({
            south: c[1] - span / 2,
            north: c[1] + span / 2,
            west: c[0] - span,
            east: c[0] + span,
          });
        };
        map.on("moveend", emit);
        emit();
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      destroyed = true;
      markersRef.current.forEach((m) => {
        try {
          m.destroy();
        } catch {
          /* ignore */
        }
      });
      markersRef.current = [];
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
    map.setCenter([center[1], center[0]]);
    map.setZoom(Math.max(map.getZoom(), 15));
  }, [center]);

  useEffect(() => {
    const map = mapRef.current;
    const mapgl = (window as any).mapgl;
    if (!map || !mapgl) return;
    markersRef.current.forEach((m) => m.destroy());
    markersRef.current = [];
    for (const p of points) {
      const marker = new mapgl.Marker(map, {
        coordinates: [p.lon, p.lat],
        label: focusId === p.id ? { text: p.name } : undefined,
      });
      marker.on("click", () => onPointClickRef.current(p));
      markersRef.current.push(marker);
    }
  }, [points, focusId]);

  if (!apiKey) {
    return (
      <div className="empty map-missing-key">
        Для 2ГИС укажите API-ключ в настройках
        <div className="muted" style={{ marginTop: 8 }}>
          Ключ: https://platform.2gis.ru/
        </div>
      </div>
    );
  }

  return <div ref={hostRef} className="provider-map" />;
}
