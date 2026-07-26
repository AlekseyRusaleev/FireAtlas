/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
}

export interface GeocodeBias {
  lat: number;
  lon: number;
  /** Радиус поиска в километрах (по умолчанию 50). */
  radiusKm?: number;
  city?: string;
}

const KEY_HINT =
  "Нужен ключ сервиса «JavaScript API и HTTP Геокодер» на developer.tech.yandex.ru.";

const DEFAULT_RADIUS_KM = 50;

/** Границы прямоугольника вокруг точки (примерно radiusKm). */
export function boundsAround(
  lat: number,
  lon: number,
  radiusKm: number
): { south: number; west: number; north: number; east: number; dLat: number; dLon: number } {
  const dLat = radiusKm / 111.32;
  const cos = Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
  const dLon = radiusKm / (111.32 * cos);
  return {
    south: lat - dLat,
    north: lat + dLat,
    west: lon - dLon,
    east: lon + dLon,
    dLat,
    dLon,
  };
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/**
 * Ищет адрес в радиусе города: Яндекс JS → Яндекс HTTP → Photon → Nominatim.
 * Работает и без ключа Яндекса (через Photon/Nominatim).
 */
export async function geocodeAddress(
  query: string,
  apiKey: string,
  bias?: GeocodeBias
): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) throw new Error("Введите адрес для поиска");

  const radiusKm = bias?.radiusKm ?? DEFAULT_RADIUS_KM;
  const city = bias?.city?.trim();
  const biasedQuery =
    city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q;

  const errors: string[] = [];

  const viaJsApi = await geocodeViaJsApi(biasedQuery, bias, radiusKm);
  if (viaJsApi) {
    assertWithinRadius(viaJsApi, bias, radiusKm);
    return viaJsApi;
  }

  if (apiKey.trim()) {
    try {
      const viaHttp = await geocodeViaHttp(biasedQuery, apiKey, bias, radiusKm);
      assertWithinRadius(viaHttp, bias, radiusKm);
      return viaHttp;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  try {
    const viaPhoton = await geocodeViaPhoton(biasedQuery, bias, radiusKm);
    if (viaPhoton) {
      assertWithinRadius(viaPhoton, bias, radiusKm);
      return viaPhoton;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  try {
    const viaNominatim = await geocodeViaNominatim(biasedQuery, bias, radiusKm);
    if (viaNominatim) {
      assertWithinRadius(viaNominatim, bias, radiusKm);
      return viaNominatim;
    }
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
  }

  const hint = apiKey.trim()
    ? errors.slice(0, 2).join(" · ")
    : `Без ключа Яндекса поиск идёт через открытые сервисы. ${KEY_HINT}`;
  throw new Error(
    bias
      ? `Адрес не найден в радиусе ${radiusKm} км от ${bias.city || "города"}: «${q}». ${hint}`
      : `Адрес не найден: «${q}». ${hint}`
  );
}

function assertWithinRadius(result: GeocodeResult, bias: GeocodeBias | undefined, radiusKm: number) {
  if (!bias) return;
  const km = distanceKm(bias.lat, bias.lon, result.lat, result.lon);
  if (km > radiusKm * 1.15) {
    throw new Error(
      `Адрес «${result.label}» найден в ${Math.round(km)} км от ${bias.city || "города по умолчанию"} — за пределами ${radiusKm} км. Уточните улицу или смените город в настройках.`
    );
  }
}

async function geocodeViaJsApi(
  q: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<GeocodeResult | null> {
  const ymaps = (window as any).ymaps;
  if (!ymaps?.geocode) return null;
  try {
    const opts: Record<string, unknown> = { results: 1 };
    if (bias) {
      const b = boundsAround(bias.lat, bias.lon, radiusKm);
      opts.boundedBy = [
        [b.south, b.west],
        [b.north, b.east],
      ];
      opts.strictBounds = true;
    }
    const res = await ymaps.geocode(q, opts);
    const first = res?.geoObjects?.get(0);
    if (!first) return null;
    const coords = first.geometry.getCoordinates();
    const label =
      (typeof first.getAddressLine === "function" ? first.getAddressLine() : null) ||
      first.properties?.get("text") ||
      q;
    return { lat: Number(coords[0]), lon: Number(coords[1]), label: String(label) };
  } catch {
    return null;
  }
}

async function geocodeViaHttp(
  q: string,
  apiKey: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<GeocodeResult> {
  let url =
    "https://geocode-maps.yandex.ru/1.x/?format=json&results=1&lang=ru_RU" +
    `&apikey=${encodeURIComponent(apiKey)}&geocode=${encodeURIComponent(q)}`;

  if (bias) {
    const b = boundsAround(bias.lat, bias.lon, radiusKm);
    url += `&ll=${bias.lon},${bias.lat}&spn=${b.dLon * 2},${b.dLat * 2}&rspn=1`;
  }

  let res: Response;
  try {
    res = await fetch(url);
  } catch (e) {
    throw new Error(
      `Не удалось связаться с геокодером Яндекса: ${e instanceof Error ? e.message : String(e)}`
    );
  }

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(`Геокодер Яндекса отклонил ключ (403). ${KEY_HINT}`);
    }
    throw new Error(`Геокодер Яндекса вернул ошибку ${res.status}`);
  }

  const data = await res.json();
  const geoObject =
    data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject ?? null;
  if (!geoObject?.Point?.pos) {
    throw new Error(
      bias
        ? `Адрес не найден в радиусе ${radiusKm} км от ${bias.city || "города"}: ${q}`
        : `Адрес не найден: ${q}`
    );
  }

  const [lon, lat] = String(geoObject.Point.pos).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new Error(`Геокодер вернул некорректные координаты для «${q}»`);
  }

  const label =
    geoObject.metaDataProperty?.GeocoderMetaData?.text || geoObject.name || q;
  return { lat, lon, label: String(label) };
}

/** Photon (Komoot) — без ключа, удобен из WebView. */
async function geocodeViaPhoton(
  q: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<GeocodeResult | null> {
  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=8&lang=ru`;
  if (bias) {
    url += `&lat=${bias.lat}&lon=${bias.lon}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photon: HTTP ${res.status}`);
  const data = await res.json();
  const features: any[] = data?.features || [];
  if (!features.length) return null;

  type Cand = GeocodeResult & { km: number };
  const cands: Cand[] = [];
  for (const f of features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = f.properties || {};
    const parts = [p.name, p.street, p.housenumber, p.city || p.town || p.village, p.state]
      .filter(Boolean)
      .map(String);
    const label = parts.length ? parts.join(", ") : q;
    const km = bias ? distanceKm(bias.lat, bias.lon, lat, lon) : 0;
    if (bias && km > radiusKm * 1.15) continue;
    cands.push({ lat, lon, label, km });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => a.km - b.km);
  return { lat: cands[0].lat, lon: cands[0].lon, label: cands[0].label };
}

async function geocodeViaNominatim(
  q: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<GeocodeResult | null> {
  let url =
    "https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=0&countrycodes=ru" +
    `&q=${encodeURIComponent(q)}`;
  if (bias) {
    const b = boundsAround(bias.lat, bias.lon, radiusKm);
    url += `&viewbox=${b.west},${b.north},${b.east},${b.south}&bounded=1`;
  }
  const res = await fetch(url, {
    headers: { Accept: "application/json", "Accept-Language": "ru" },
  });
  if (!res.ok) throw new Error(`Nominatim: HTTP ${res.status}`);
  const items: any[] = await res.json();
  if (!Array.isArray(items) || !items.length) return null;

  for (const item of items) {
    const lat = Number(item.lat);
    const lon = Number(item.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (bias) {
      const km = distanceKm(bias.lat, bias.lon, lat, lon);
      if (km > radiusKm * 1.15) continue;
    }
    return {
      lat,
      lon,
      label: String(item.display_name || q),
    };
  }
  return null;
}
