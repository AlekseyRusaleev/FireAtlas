/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import type { UserMarker, WaterPoint } from "../../shared/types";
import type { SearchPin } from "./YandexMapView";

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

export function DgisMapView({
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
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const userMarkersRef = useRef<any[]>([]);
  const pinRef = useRef<any>(null);
  const focusZoomRef = useRef(focusZoom);
  const pickModeRef = useRef(pickMode);
  focusZoomRef.current = focusZoom;
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onPointClickRef = useRef(onPointClick);
  const onMapPickRef = useRef(onMapPick);
  const onMarkerClickRef = useRef(onMarkerClick);
  pickModeRef.current = pickMode;
  onBoundsChangeRef.current = onBoundsChange;
  onPointClickRef.current = onPointClick;
  onMapPickRef.current = onMapPick;
  onMarkerClickRef.current = onMarkerClick;

  useEffect(() => {
    let destroyed = false;
    setMapReady(false);
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
        setMapReady(true);

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
        map.on("click", (e: any) => {
          if (!pickModeRef.current) return;
          const lngLat = e?.lngLat;
          if (lngLat) onMapPickRef.current?.(Number(lngLat[1]), Number(lngLat[0]));
        });
        emit();
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      destroyed = true;
      [...markersRef.current, ...userMarkersRef.current, pinRef.current].forEach((m) => {
        try {
          m?.destroy();
        } catch {
          /* ignore */
        }
      });
      markersRef.current = [];
      userMarkersRef.current = [];
      pinRef.current = null;
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
    map.setZoom(Math.max(map.getZoom(), focusZoomRef.current));
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
  }, [points, focusId, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const mapgl = (window as any).mapgl;
    if (!map || !mapgl) return;
    userMarkersRef.current.forEach((m) => m.destroy());
    userMarkersRef.current = [];
    for (const m of markers) {
      const marker = new mapgl.Marker(map, {
        coordinates: [m.lon, m.lat],
        label: { text: m.name },
      });
      marker.on("click", () => onMarkerClickRef.current?.(m));
      userMarkersRef.current.push(marker);
    }
  }, [markers, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    const mapgl = (window as any).mapgl;
    if (!map || !mapgl) return;
    try {
      pinRef.current?.destroy();
    } catch {
      /* ignore */
    }
    pinRef.current = null;
    if (!searchPin) return;
    pinRef.current = new mapgl.Marker(map, {
      coordinates: [searchPin.lon, searchPin.lat],
      label: { text: searchPin.label },
      zIndex: 1000,
    });
  }, [searchPin, mapReady]);

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
