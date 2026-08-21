/* eslint-disable @typescript-eslint/no-explicit-any */

export interface GeocodeResult {
  lat: number;
  lon: number;
  label: string;
}

export interface AddressSuggestion {
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

/** Self-hosted Nominatim (сейчас — Кемеровская область). */
const OWN_NOMINATIM_BASE = "https://geo.infocardmchs.ru";

export const STREET_STOP = new Set([
  "улица",
  "ул",
  "проспект",
  "пр",
  "пр-т",
  "п-т",
  "пр-кт",
  "просп",
  "переулок",
  "пер",
  "шоссе",
  "проезд",
  "бульвар",
  "наб",
  "набережная",
  "площадь",
  "пл",
  "дом",
  "д",
  "город",
  "г",
  "микрорайон",
  "мкр",
]);

const STREET_TYPES = [
  "проспект",
  "улица",
  "переулок",
  "площадь",
  "бульвар",
  "шоссе",
  "набережная",
  "проезд",
  "микрорайон",
] as const;

/** Слова места/региона — не улица; в названиях ИК их часто нет. */
export const PLACE_STOP = new Set([
  "россия",
  "область",
  "край",
  "республика",
  "район",
  "округ",
  "городской",
  "муниципальный",
  "кемерово",
  "новокузнецк",
  "ленинск",
  "центральный",
  "заводский",
  "ленинский",
  "рудничный",
  "кировский",
]);

/** «59а», «90,1», «90/1», «59-1», «88 a». */
export const HOUSE_NUM_RE = "\\d+[а-яa-z]?(?:\\s*[\\/,.\\-\\u2013\\u2014]\\s*\\d+[а-яa-z]?)?";

interface ParsedQuery {
  streetTokens: string[];
  house: string | null;
  streetType: string | null;
}

interface RankedCandidate extends GeocodeResult {
  score: number;
  km: number;
  house?: string | null;
  street?: string | null;
}

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

const LETTER_LEFT = "(^|[^0-9а-яёА-ЯЁa-zA-Z])";

/** пр.Ленина / прЛенина / п-т. Октябрьский → «проспект …» с пробелом. */
export function expandStreetAbbreviations(raw: string): string {
  const toWord = (word: string) => (_m: string, pre: string) => `${pre}${word} `;
  // «прЛенина»: только заглавная после сокращения — иначе «променад» станет «проспект оменад».
  const glued = (abbr: string) => new RegExp(`${LETTER_LEFT}(?:${abbr})(?=[А-ЯЁ])`, "g");
  return raw
    .replace(/[–—−]/g, "-")
    .replace(new RegExp(`${LETTER_LEFT}п-?т\\.?`, "gi"), toWord("проспект"))
    .replace(new RegExp(`${LETTER_LEFT}пр-?кт\\.?`, "gi"), toWord("проспект"))
    .replace(new RegExp(`${LETTER_LEFT}пр-?т\\.?`, "gi"), toWord("проспект"))
    .replace(new RegExp(`${LETTER_LEFT}пр\\.`, "gi"), toWord("проспект"))
    .replace(new RegExp(`${LETTER_LEFT}пр(\\s+)`, "gi"), (_m, pre: string) => `${pre}проспект `)
    .replace(new RegExp(`${LETTER_LEFT}пр-(?=[А-ЯЁа-яё])`, "g"), toWord("проспект"))
    .replace(glued("пр|ПР|Пр"), toWord("проспект"))
    .replace(new RegExp(`${LETTER_LEFT}ул\\.`, "gi"), toWord("улица"))
    .replace(new RegExp(`${LETTER_LEFT}ул(\\s+)`, "gi"), (_m, pre: string) => `${pre}улица `)
    .replace(glued("ул|УЛ|Ул"), toWord("улица"))
    .replace(new RegExp(`${LETTER_LEFT}пер\\.`, "gi"), toWord("переулок"))
    .replace(new RegExp(`${LETTER_LEFT}пер(\\s+)`, "gi"), (_m, pre: string) => `${pre}переулок `)
    .replace(glued("пер|ПЕР|Пер"), toWord("переулок"))
    .replace(new RegExp(`${LETTER_LEFT}наб\\.`, "gi"), toWord("набережная"))
    .replace(new RegExp(`${LETTER_LEFT}пл\\.`, "gi"), toWord("площадь"))
    .replace(new RegExp(`${LETTER_LEFT}б-р\\.?`, "gi"), toWord("бульвар"))
    .replace(new RegExp(`${LETTER_LEFT}мкр\\.`, "gi"), toWord("микрорайон"))
    .replace(new RegExp(`${LETTER_LEFT}д\\.?\\s*(?=\\d)`, "gi"), "$1")
    .replace(/,/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldHouseChars(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/a/g, "а")
    .replace(/b/g, "б")
    .replace(/c/g, "с")
    .replace(/e/g, "е")
    .replace(/h/g, "н")
    .replace(/k/g, "к")
    .replace(/m/g, "м")
    .replace(/o/g, "о")
    .replace(/p/g, "р")
    .replace(/t/g, "т")
    .replace(/x/g, "х")
    .replace(/y/g, "у");
}

function normalizeHouse(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let h = foldHouseChars(raw)
    .replace(/^д\.?\s*/i, "")
    .replace(/\s+/g, "")
    .replace(/корп(?:ус)?/g, "/")
    .replace(/строен(?:ие)?/g, "/")
    .replace(/,/g, "/")
    .replace(/\./g, "/")
    .replace(/-/g, "/")
    .replace(/(\d)к(\d)/g, "$1/$2")
    .trim();
  return h || null;
}

function detectStreetType(q: string): string | null {
  const lower = q.toLowerCase();
  for (const t of STREET_TYPES) {
    const re = new RegExp(`(^|[^0-9а-яёa-z])${t}([^0-9а-яёa-z]|$)`, "i");
    if (re.test(lower)) return t;
  }
  return null;
}

function tokenizeStreet(raw: string): string[] {
  return raw
    .toLowerCase()
    .replace(/[«»"']/g, " ")
    .split(/[\s,./]+/)
    .map((t) => t.trim())
    .filter(
      (t) =>
        t.length >= 3 &&
        !STREET_STOP.has(t) &&
        !PLACE_STOP.has(t) &&
        !/^\d{5,6}$/.test(t) &&
        !new RegExp(`^${HOUSE_NUM_RE}$`, "i").test(t)
    );
}

function isPostalCode(num: string): boolean {
  return /^\d{5,6}$/.test(num);
}

/** Разбор «Ленина 56», «Ленина, 62Б, Кемерово», «62Б, проспект Ленина, …». */
export function parseAddressQuery(query: string): ParsedQuery {
  let q = expandStreetAbbreviations(query);

  let house: string | null = null;

  // Nominatim: «62Б, проспект Ленина, район, город…»
  const leading = q.match(new RegExp(`^(${HOUSE_NUM_RE})\\s*,\\s*`, "i"));
  if (leading && !isPostalCode(leading[1])) {
    house = normalizeHouse(leading[1]);
    q = q.slice(leading[0].length).trim();
  }

  // «… Ленина, 62Б, Кемерово» или «… Ленина 62Б» / «90,1» в конце / перед городом
  if (!house) {
    const beforePlace = q.match(
      new RegExp(`(?:,\\s*|\\s+)(?:дом\\s+)?(${HOUSE_NUM_RE})(?=\\s*,\\s*[^\\d]|\\s*$)`, "i")
    );
    if (beforePlace && !isPostalCode(beforePlace[1])) {
      house = normalizeHouse(beforePlace[1]);
      q = `${q.slice(0, beforePlace.index)} ${q.slice((beforePlace.index || 0) + beforePlace[0].length)}`
        .replace(/[,\s]+/g, " ")
        .trim();
    }
  }

  // Убрать хвост «область / Россия / индекс» из токенизации улицы
  q = q
    .replace(/\b\d{5,6}\b/g, " ")
    .replace(/\bроссия\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  const streetType = detectStreetType(q);
  return { streetTokens: tokenizeStreet(q), house, streetType };
}

/**
 * Из названия ИК достаём только улицу и дом: «ТРК Лапландия, п-т. Октябрьский, 34»
 * → «проспект Октябрьский, 34». Название ТЦ в геокодер не отдаём.
 */
export function extractStreetAddress(title: string): string | null {
  const expanded = expandStreetAbbreviations(title);
  const typedRe = new RegExp(
    `(?:${STREET_TYPES.join("|")})\\s+[^,]+?,?\\s*(?:дом\\s+)?${HOUSE_NUM_RE}`,
    "gi"
  );
  let typed: RegExpExecArray | null = null;
  let m: RegExpExecArray | null;
  while ((m = typedRe.exec(expanded))) typed = m;
  if (typed) return typed[0].replace(/\s+/g, " ").trim();

  const parsed = parseAddressQuery(expanded);
  if (parsed.house && parsed.streetTokens.length > 0) {
    const street = parsed.streetTokens[parsed.streetTokens.length - 1];
    const commaHouse = new RegExp(`,\\s*(?:дом\\s+)?${HOUSE_NUM_RE}\\s*$`, "i");
    // Тип улицы уже известен, либо дом идёт после запятой («Ленина, 59а»), а не «Променад 3»
    if (parsed.streetType || commaHouse.test(expanded)) {
      const type = parsed.streetType ? `${parsed.streetType} ` : "";
      return `${type}${street}, ${parsed.house}`;
    }
  }
  return null;
}

function houseMatches(wanted: string | null, got: string | null | undefined): boolean {
  if (!wanted) return true;
  const g = normalizeHouse(got);
  const w = normalizeHouse(wanted);
  if (!g || !w) return false;
  if (g === w) return true;
  // «59а» и «59а/1» не считаем равными; «90,1» уже свёрнут в 90/1
  return false;
}

/** Номер дома как отдельный фрагмент адреса, не «Променад-1». */
function houseInLabel(label: string, wanted: string): boolean {
  const w = normalizeHouse(wanted);
  if (!w) return false;
  const folded = foldHouseChars(label).replace(/,/g, "/");
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[,;/\\s]|\\bдом\\s+)${esc}(?=$|[,;/\\s])`, "i");
  return re.test(folded);
}

function scoreCandidate(
  cand: Omit<RankedCandidate, "score">,
  parsed: ParsedQuery,
  bias: GeocodeBias | undefined,
  radiusKm: number
): number | null {
  if (bias && cand.km > radiusKm * 1.15) return null;

  const hay = `${cand.label} ${cand.street || ""} ${cand.house || ""}`.toLowerCase();
  const streetHits = parsed.streetTokens.filter((t) => hay.includes(t)).length;
  const streetNeed = parsed.streetTokens.length;

  // Есть улица в запросе, но ни одного значимого слова в ответе — отбрасываем
  if (streetNeed > 0 && streetHits === 0) return null;

  // В запросе указан дом — не берём чужой дом и не верим подписи, если геокодер отдал поле house
  if (parsed.house) {
    if (cand.house) {
      if (!houseMatches(parsed.house, cand.house)) return null;
    } else if (!houseInLabel(cand.label, parsed.house)) {
      return null;
    }
  }

  let score = 0;
  if (streetNeed > 0) {
    score += Math.round((streetHits / streetNeed) * 500);
    if (streetHits === streetNeed) score += 200;
  }
  if (parsed.streetType && cand.street && cand.street.toLowerCase().includes(parsed.streetType)) {
    score += 80;
  }
  if (parsed.house && houseMatches(parsed.house, cand.house)) {
    score += 800;
  } else if (parsed.house && houseInLabel(cand.label, parsed.house)) {
    score += 720;
  } else if (!parsed.house) {
    score += 50;
  }

  // ближе к центру города — чуть лучше при равном качестве
  score -= Math.min(120, cand.km * 2);
  return score;
}

function pickBest(
  cands: RankedCandidate[],
  parsed: ParsedQuery,
  bias: GeocodeBias | undefined,
  radiusKm: number
): GeocodeResult | null {
  const ranked: RankedCandidate[] = [];
  for (const c of cands) {
    const score = scoreCandidate(c, parsed, bias, radiusKm);
    if (score == null) continue;
    ranked.push({ ...c, score });
  }
  if (!ranked.length) return null;
  ranked.sort((a, b) => b.score - a.score || a.km - b.km);
  const best = ranked[0];
  // слишком слабое совпадение без дома — не выдаём «что-нибудь рядом»
  if (parsed.house && best.score < 700) return null;
  if (!parsed.house && parsed.streetTokens.length > 0 && best.score < 200) return null;
  return { lat: best.lat, lon: best.lon, label: best.label };
}

function uniqueLabels(items: string[]): AddressSuggestion[] {
  const seen = new Set<string>();
  const out: AddressSuggestion[] = [];
  for (const label of items) {
    const key = label.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({ label: label.trim() });
    if (out.length >= 8) break;
  }
  return out;
}

const GEOCODE_CACHE_LIMIT = 120;
const geocodeCache = new Map<string, GeocodeResult>();
const geocodeInflight = new Map<string, Promise<GeocodeResult>>();

function geocodeCacheKey(query: string, bias?: GeocodeBias): string {
  const city = (bias?.city || "").trim().toLowerCase();
  const lat = bias ? bias.lat.toFixed(3) : "";
  const lon = bias ? bias.lon.toFixed(3) : "";
  return `${query.trim().toLowerCase()}|${city}|${lat}|${lon}`;
}

function rememberGeocode(key: string, result: GeocodeResult): GeocodeResult {
  geocodeCache.delete(key);
  geocodeCache.set(key, result);
  while (geocodeCache.size > GEOCODE_CACHE_LIMIT) {
    const oldest = geocodeCache.keys().next().value;
    if (oldest == null) break;
    geocodeCache.delete(oldest);
  }
  return result;
}

async function gather<T>(jobs: Array<Promise<T[]>>, errors: string[]): Promise<T[]> {
  const settled = await Promise.allSettled(jobs);
  const out: T[] = [];
  for (const item of settled) {
    if (item.status === "fulfilled") out.push(...item.value);
    else errors.push(item.reason instanceof Error ? item.reason.message : String(item.reason));
  }
  return out;
}

/**
 * Ищет адрес в радиусе города: свой Nominatim, при неудаче — Яндекс / Photon / публичный OSM.
 * Как только есть точное совпадение по улице и дому — сразу возвращаем, без ожидания запасных сервисов.
 */
export async function geocodeAddress(
  query: string,
  apiKey: string,
  bias?: GeocodeBias
): Promise<GeocodeResult> {
  const q = query.trim();
  if (!q) throw new Error("Введите адрес для поиска");
  const key = geocodeCacheKey(q, bias);
  const cached = geocodeCache.get(key);
  if (cached) return cached;
  const pending = geocodeInflight.get(key);
  if (pending) return pending;

  const work = geocodeAddressUncached(q, apiKey, bias)
    .then((result) => rememberGeocode(key, result))
    .finally(() => {
      geocodeInflight.delete(key);
    });
  geocodeInflight.set(key, work);
  return work;
}

async function geocodeAddressUncached(
  q: string,
  apiKey: string,
  bias?: GeocodeBias
): Promise<GeocodeResult> {
  const radiusKm = bias?.radiusKm ?? DEFAULT_RADIUS_KM;
  const city = bias?.city?.trim();
  const biasedQuery =
    city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q;
  const parsed = parseAddressQuery(q);

  const queryVariants = [biasedQuery];
  if (parsed.house && parsed.streetTokens.length) {
    const street = parsed.streetTokens.join(" ");
    const named = parsed.streetType ? `${parsed.streetType} ${street}` : street;
    const suffix = city ? `, ${city}` : "";
    queryVariants.push(`${named}, ${parsed.house}${suffix}`);
    // «улица Ленина» и «проспект Ленина» — разные улицы; не подставляем «улица», если тип уже известен
    if (!parsed.streetType) {
      queryVariants.push(`улица ${street}, ${parsed.house}${suffix}`);
    }
  }
  const uniqueQueries = [...new Set(queryVariants)];
  const errors: string[] = [];
  const pool: RankedCandidate[] = [];

  const take = (extra: RankedCandidate[]) => {
    pool.push(...extra);
    return pickBest(pool, parsed, bias, radiusKm);
  };

  const own = await gather(
    uniqueQueries.map((candidate) =>
      geocodeViaNominatim(candidate, bias, radiusKm, city, parsed, OWN_NOMINATIM_BASE)
    ),
    errors
  );
  let best = take(own);
  if (best) {
    assertWithinRadius(best, bias, radiusKm);
    return best;
  }

  const yandex: Array<Promise<RankedCandidate[]>> = uniqueQueries.map((candidate) =>
    geocodeViaJsApi(candidate, bias, radiusKm)
  );
  if (apiKey.trim()) {
    for (const candidate of uniqueQueries) {
      yandex.push(geocodeViaHttp(candidate, apiKey, bias, radiusKm));
    }
  }
  best = take(await gather(yandex, errors));
  if (best) {
    assertWithinRadius(best, bias, radiusKm);
    return best;
  }

  best = take(
    await gather(
      uniqueQueries.map((candidate) => geocodeViaPhoton(candidate, bias, radiusKm)),
      errors
    )
  );
  if (best) {
    assertWithinRadius(best, bias, radiusKm);
    return best;
  }

  best = take(
    await gather(
      uniqueQueries.map((candidate) =>
        geocodeViaNominatim(candidate, bias, radiusKm, city, parsed, "https://nominatim.openstreetmap.org")
      ),
      errors
    )
  );
  if (best) {
    assertWithinRadius(best, bias, radiusKm);
    return best;
  }

  const hint = apiKey.trim()
    ? errors.slice(0, 2).join(" · ")
    : `Поиск: свой геокодер (${OWN_NOMINATIM_BASE}) и открытые OSM-сервисы. ${errors[0] || ""}`.trim();
  throw new Error(
    bias
      ? `Адрес не найден точно в радиусе ${radiusKm} км от ${bias.city || "города"}: «${q}». Уточните улицу и номер дома. ${hint}`
      : `Адрес не найден точно: «${q}». ${hint}`
  );
}

export async function suggestAddresses(
  query: string,
  bias?: GeocodeBias
): Promise<AddressSuggestion[]> {
  const q = query.trim();
  if (q.length < 3) return [];

  const city = bias?.city?.trim();
  const biasedQuery =
    city && !q.toLowerCase().includes(city.toLowerCase()) ? `${q}, ${city}` : q;
  const labels: string[] = [];

  try {
    const ymaps = (window as any).ymaps;
    if (ymaps?.geocode) {
      const opts: Record<string, unknown> = { results: 6 };
      if (bias) {
        const b = boundsAround(bias.lat, bias.lon, bias.radiusKm ?? DEFAULT_RADIUS_KM);
        opts.boundedBy = [
          [b.south, b.west],
          [b.north, b.east],
        ];
        opts.strictBounds = true;
      }
      const res = await ymaps.geocode(biasedQuery, opts);
      const n = res?.geoObjects?.getLength?.() ?? 0;
      for (let i = 0; i < n; i++) {
        const obj = res.geoObjects.get(i);
        const label =
          (typeof obj?.getAddressLine === "function" ? obj.getAddressLine() : null) ||
          obj?.properties?.get("text");
        if (label) labels.push(String(label));
      }
    }
  } catch {
    // suggestions are best-effort only
  }

  try {
    let nominatimUrl =
      `${OWN_NOMINATIM_BASE}/search?format=json&addressdetails=1&limit=8&countrycodes=ru` +
      `&q=${encodeURIComponent(biasedQuery)}`;
    if (bias) {
      const b = boundsAround(bias.lat, bias.lon, bias.radiusKm ?? DEFAULT_RADIUS_KM);
      nominatimUrl += `&viewbox=${b.west},${b.north},${b.east},${b.south}&bounded=1`;
    }
    const res = await fetch(nominatimUrl, {
      headers: { Accept: "application/json", "Accept-Language": "ru" },
    });
    if (res.ok) {
      const items: any[] = await res.json();
      for (const item of items) {
        const addr = item?.address || {};
        const parts = [
          addr.road || addr.pedestrian || addr.residential,
          addr.house_number,
          addr.city || addr.town || addr.village,
        ]
          .filter(Boolean)
          .map(String);
        if (parts.length) {
          labels.push(parts.join(", "));
        } else if (item?.display_name) {
          labels.push(String(item.display_name));
        }
      }
    }
  } catch {
    // suggestions are best-effort only
  }

  try {
    let photonUrl = `https://photon.komoot.io/api/?q=${encodeURIComponent(biasedQuery)}&limit=8&lang=ru`;
    if (bias) {
      photonUrl += `&lat=${bias.lat}&lon=${bias.lon}`;
    }
    const res = await fetch(photonUrl);
    if (res.ok) {
      const data = await res.json();
      const features: any[] = data?.features || [];
      for (const f of features) {
        const p = f?.properties || {};
        const parts = [p.street || p.name, p.housenumber, p.city || p.town || p.village]
          .filter(Boolean)
          .map(String);
        if (parts.length) labels.push(parts.join(", "));
      }
    }
  } catch {
    // suggestions are best-effort only
  }

  return uniqueLabels(labels);
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
): Promise<RankedCandidate[]> {
  const ymaps = (window as any).ymaps;
  if (!ymaps?.geocode) return [];
  try {
    const opts: Record<string, unknown> = { results: 5 };
    if (bias) {
      const b = boundsAround(bias.lat, bias.lon, radiusKm);
      opts.boundedBy = [
        [b.south, b.west],
        [b.north, b.east],
      ];
      opts.strictBounds = true;
    }
    const res = await ymaps.geocode(q, opts);
    const out: RankedCandidate[] = [];
    const n = res?.geoObjects?.getLength?.() ?? 0;
    for (let i = 0; i < n; i++) {
      const obj = res.geoObjects.get(i);
      if (!obj) continue;
      const coords = obj.geometry.getCoordinates();
      const lat = Number(coords[0]);
      const lon = Number(coords[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const meta = obj.properties?.get("metaDataProperty")?.GeocoderMetaData;
      const house =
        meta?.Address?.Components?.find((c: any) => c.kind === "house")?.name ||
        null;
      const street =
        meta?.Address?.Components?.find((c: any) => c.kind === "street")?.name ||
        null;
      const label =
        (typeof obj.getAddressLine === "function" ? obj.getAddressLine() : null) ||
        obj.properties?.get("text") ||
        [street, house].filter(Boolean).join(", ") ||
        "адрес";
      out.push({
        lat,
        lon,
        label: String(label),
        score: 0,
        km: bias ? distanceKm(bias.lat, bias.lon, lat, lon) : 0,
        house,
        street,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function geocodeViaHttp(
  q: string,
  apiKey: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<RankedCandidate[]> {
  let url =
    "https://geocode-maps.yandex.ru/1.x/?format=json&results=5&lang=ru_RU" +
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
  const members: any[] = data?.response?.GeoObjectCollection?.featureMember || [];
  const out: RankedCandidate[] = [];
  for (const m of members) {
    const geoObject = m?.GeoObject;
    if (!geoObject?.Point?.pos) continue;
    const [lon, lat] = String(geoObject.Point.pos).trim().split(/\s+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const comps: any[] =
      geoObject.metaDataProperty?.GeocoderMetaData?.Address?.Components || [];
    const house = comps.find((c) => c.kind === "house")?.name || null;
    const street = comps.find((c) => c.kind === "street")?.name || null;
    const label =
      geoObject.metaDataProperty?.GeocoderMetaData?.text ||
      geoObject.name ||
      [street, house].filter(Boolean).join(", ") ||
      "адрес";
    out.push({
      lat,
      lon,
      label: String(label),
      score: 0,
      km: bias ? distanceKm(bias.lat, bias.lon, lat, lon) : 0,
      house,
      street,
    });
  }
  return out;
}

/** Photon (Komoot) — без ключа, удобен из WebView. */
async function geocodeViaPhoton(
  q: string,
  bias: GeocodeBias | undefined,
  radiusKm: number
): Promise<RankedCandidate[]> {
  let url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=12&lang=ru`;
  if (bias) {
    url += `&lat=${bias.lat}&lon=${bias.lon}`;
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Photon: HTTP ${res.status}`);
  const data = await res.json();
  const features: any[] = data?.features || [];
  const out: RankedCandidate[] = [];
  for (const f of features) {
    const coords = f?.geometry?.coordinates;
    if (!Array.isArray(coords) || coords.length < 2) continue;
    const lon = Number(coords[0]);
    const lat = Number(coords[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const p = f.properties || {};
    const street = p.street ? String(p.street) : null;
    const house = p.housenumber ? String(p.housenumber) : null;
    const parts = [street, house, p.city || p.town || p.village, p.state]
      .filter(Boolean)
      .map(String);
    // name часто — POI; улицу/дом ставим первыми для понятной подписи
    const label = parts.length ? parts.join(", ") : p.name ? String(p.name) : "адрес";
    const km = bias ? distanceKm(bias.lat, bias.lon, lat, lon) : 0;
    if (bias && km > radiusKm * 1.15) continue;
    out.push({ lat, lon, label, score: 0, km, house, street });
  }
  return out;
}

async function geocodeViaNominatim(
  q: string,
  bias: GeocodeBias | undefined,
  radiusKm: number,
  city: string | undefined,
  parsed: ParsedQuery,
  hostBase: string = OWN_NOMINATIM_BASE
): Promise<RankedCandidate[]> {
  const urls: string[] = [];
  const base = `${hostBase.replace(/\/$/, "")}/search?format=json&addressdetails=1&limit=8&countrycodes=ru`;

  if (parsed.house && parsed.streetTokens.length && city) {
    const streetName = [parsed.streetType, ...parsed.streetTokens].filter(Boolean).join(" ");
    urls.push(
      `${base}&street=${encodeURIComponent(`${parsed.house} ${streetName}`)}&city=${encodeURIComponent(city)}`
    );
  }
  urls.push(`${base}&q=${encodeURIComponent(q)}`);

  const jobs = urls.map(async (url0) => {
    let url = url0;
    if (bias) {
      const b = boundsAround(bias.lat, bias.lon, radiusKm);
      url += `&viewbox=${b.west},${b.north},${b.east},${b.south}&bounded=1`;
    }
    const res = await fetch(url, {
      headers: { Accept: "application/json", "Accept-Language": "ru" },
    });
    if (!res.ok) throw new Error(`Nominatim: HTTP ${res.status}`);
    const items: any[] = await res.json();
    if (!Array.isArray(items)) return [] as RankedCandidate[];
    const local: RankedCandidate[] = [];
    for (const item of items) {
      const lat = Number(item.lat);
      const lon = Number(item.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const km = bias ? distanceKm(bias.lat, bias.lon, lat, lon) : 0;
      if (bias && km > radiusKm * 1.15) continue;
      const addr = item.address || {};
      local.push({
        lat,
        lon,
        label: String(item.display_name || [addr.road, addr.house_number].filter(Boolean).join(", ") || "адрес"),
        score: 0,
        km,
        house: addr.house_number ? String(addr.house_number) : null,
        street: addr.road || addr.pedestrian || addr.residential || null,
      });
    }
    return local;
  });
  const settled = await Promise.allSettled(jobs);
  const out: RankedCandidate[] = [];
  let lastErr: string | null = null;
  for (const item of settled) {
    if (item.status === "fulfilled") out.push(...item.value);
    else lastErr = item.reason instanceof Error ? item.reason.message : String(item.reason);
  }
  if (out.length === 0 && lastErr) throw new Error(lastErr);
  return out;
}
