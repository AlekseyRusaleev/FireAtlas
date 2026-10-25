import { useEffect, useMemo, useState } from "react";
import * as api from "../../shared/api";
import type { AddressPlace } from "../../shared/types";

interface Props {
  selectedId?: string;
  selectedName?: string;
  onPick: (place: AddressPlace) => void;
}

export function PlaceSelect({ selectedId, selectedName, onPick }: Props) {
  const [places, setPlaces] = useState<AddressPlace[]>([]);
  const [query, setQuery] = useState(selectedName || "");
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setQuery(selectedName || "");
  }, [selectedName]);

  useEffect(() => {
    let cancelled = false;
    void api
      .listAddressPlaces()
      .then((items) => {
        if (!cancelled) setPlaces(items);
      })
      .catch(() => {
        if (!cancelled) setPlaces([]);
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const hints = useMemo(() => {
    const q = query.trim().toLowerCase();
    const ranked = q
      ? places.filter((p) => `${p.name} ${p.region}`.toLowerCase().includes(q))
      : places;
    const regions = ranked.filter((p) => p.kind === "region").slice(0, 10);
    const cities = ranked
      .filter((p) => p.kind === "city")
      .slice(0, q ? 14 : 8);
    return [...regions, ...cities];
  }, [places, query]);

  const selected = places.find((p) => p.id === selectedId);

  return (
    <div className="city-field">
      <label>Город или область СФО</label>
      <input
        value={query}
        placeholder="Начните вводить: Новосибирск, Кемерово, край…"
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          window.setTimeout(() => setOpen(false), 160);
        }}
      />
      {open && hints.length > 0 && (
        <div className="city-hints">
          {hints.map((place) => (
            <button
              key={place.id}
              type="button"
              className="city-hint"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQuery(place.name);
                setOpen(false);
                onPick(place);
              }}
            >
              <strong>{place.name}</strong>
              <span className="muted">
                {place.kind === "region"
                  ? `весь субъект · ${place.count.toLocaleString("ru-RU")} адресов`
                  : `${place.region} · ${place.count.toLocaleString("ru-RU")} адресов`}
              </span>
            </button>
          ))}
        </div>
      )}
      {loaded && places.length === 0 && (
        <div className="muted">Каталог адресов СФО не найден рядом с программой.</div>
      )}
      {selected && (
        <div className="muted">
          Выбрано: <strong>{selected.name}</strong>
          {selected.kind === "city" ? ` · ${selected.region}` : " · весь субъект"}. Поиск улицы и
          дома идёт по локальному файлу, без интернета.
        </div>
      )}
    </div>
  );
}
