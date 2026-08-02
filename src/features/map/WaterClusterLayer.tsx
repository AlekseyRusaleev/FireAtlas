import { useEffect } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import type { WaterPoint, WaterType } from "../../shared/types";

function typeColor(type: WaterType): string {
  switch (type) {
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

export function waterDotIcon(type: WaterType, focused = false): L.DivIcon {
  const color = typeColor(type);
  const size = focused ? 18 : 14;
  return L.divIcon({
    className: "",
    html: `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:${
      focused ? `0 0 0 6px ${color}55,` : ""
    }0 1px 4px rgba(0,0,0,.5)"></div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

interface Props {
  points: WaterPoint[];
  focusId?: number | null;
  pickMode?: boolean;
  onPointClick: (p: WaterPoint) => void;
  onPick?: (lat: number, lon: number) => void;
}

/** Кластеризация ИППВ — как в веб-кабинете Infocard (leaflet.markercluster). */
export function WaterClusterLayer({
  points,
  focusId = null,
  pickMode = false,
  onPointClick,
  onPick,
}: Props) {
  const map = useMap();

  useEffect(() => {
    const cluster = L.markerClusterGroup({
      maxClusterRadius: 48,
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      disableClusteringAtZoom: 18,
      chunkedLoading: true,
    });

    for (const p of points) {
      const marker = L.marker([p.lat, p.lon], {
        icon: waterDotIcon(p.water_type, focusId === p.id),
      });
      marker.on("click", (e) => {
        L.DomEvent.stopPropagation(e);
        if (pickMode) {
          onPick?.(p.lat, p.lon);
        } else {
          onPointClick(p);
        }
      });
      marker.bindTooltip(p.name);
      cluster.addLayer(marker);
    }

    map.addLayer(cluster);
    return () => {
      map.removeLayer(cluster);
    };
  }, [map, points, focusId, pickMode, onPointClick, onPick]);

  return null;
}
