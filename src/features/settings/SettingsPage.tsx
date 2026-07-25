import { useMemo, useState } from "react";
import * as api from "../../shared/api";
import {
  CITIES,
  type AppSettings,
  type IndexStats,
  type MapProviderId,
} from "../../shared/types";

interface Props {
  settings: AppSettings;
  stats: IndexStats | null;
  onSaved: (settings: AppSettings) => Promise<void>;
  onReindexed: () => Promise<void>;
}

export function SettingsPage({ settings, stats, onSaved, onReindexed }: Props) {
  const [form, setForm] = useState<AppSettings>({
    ...settings,
    default_city: settings.default_city || "Кемерово",
  });
  const [cityQuery, setCityQuery] = useState(settings.default_city || "");
  const [showHints, setShowHints] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const hints = useMemo(() => {
    const q = cityQuery.trim().toLowerCase();
    if (!q) return CITIES.slice(0, 8);
    return CITIES.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8);
  }, [cityQuery]);

  async function pickFolder() {
    const path = await api.pickDataFolder();
    if (path) setForm((f) => ({ ...f, data_path: path }));
  }

  async function ensureSaved(): Promise<AppSettings> {
    const saved = await api.saveSettings(form);
    await onSaved(saved);
    setForm(saved);
    return saved;
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      await ensureSaved();
      setMessage("Настройки сохранены");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    setBusy(true);
    setMessage("Сохранение и индексация… Не закрывайте окно.");
    try {
      await ensureSaved();
      const report = await api.reindex();
      await onReindexed();
      const errTail =
        report.errors.length > 0
          ? `\nОшибки:\n- ${report.errors.slice(0, 5).join("\n- ")}`
          : "";
      setMessage(
        `${report.hint}\nФайлов карт: ${report.files_found}, точек: ${report.points_parsed}, карточек: ${report.cards}${errTail}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importKmz() {
    setBusy(true);
    setMessage("Выберите файлы KML/KMZ… После выбора идёт индексация — подождите.");
    try {
      await ensureSaved();
      const report = await api.importKmzFiles();
      await onReindexed();
      setMessage(
        `${report.hint}\nИмпортировано файлов: ${report.files_ok}, ВО в индексе: ${report.water_points}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function applyCity(name: string) {
    const city = CITIES.find((c) => c.name.toLowerCase() === name.toLowerCase())
      ?? CITIES.find((c) => c.name.toLowerCase().includes(name.trim().toLowerCase()));
    if (!city) {
      setForm((f) => ({ ...f, default_city: name }));
      setCityQuery(name);
      setShowHints(false);
      setMessage(`Город «${name}» сохранён как название. Выберите город из подсказок, чтобы задать координаты карты.`);
      return;
    }
    setForm((f) => ({
      ...f,
      default_city: city.name,
      default_lat: city.lat,
      default_lon: city.lon,
      default_zoom: city.zoom,
    }));
    setCityQuery(city.name);
    setShowHints(false);
  }

  function searchCity() {
    const q = cityQuery.trim();
    if (!q) return;
    applyCity(q);
  }

  return (
    <div className="panel settings-layout">
      <form
        className="settings-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 style={{ margin: 0 }}>Настройки</h2>

        <div className="field">
          <label>Путь к базе данных</label>
          <div className="row">
            <input
              value={form.data_path}
              onChange={(e) => setForm({ ...form, data_path: e.target.value })}
              placeholder="Z:\ или папка с KMZ и Информационные карточки"
            />
            <button type="button" className="btn" onClick={() => void pickFolder()}>
              Обзор…
            </button>
          </div>
          <div className="muted">
            Ищутся папки <code>KMZ</code>/<code>Maps</code> и{" "}
            <code>Информационные карточки</code> (или <code>KTP</code>). Можно указать сам
            диск Yandex IPSCH (Z:).
          </div>
        </div>

        <div className="field">
          <label>Водоисточники (KML/KMZ)</label>
          <div className="actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void importKmz()}
            >
              Импорт KML / KMZ…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void reindex()}
            >
              Переиндексировать базу
            </button>
          </div>
          <div className="muted">
            Большие файлы индексируются несколько секунд — окно может ненадолго «думать», это
            нормально.
          </div>
        </div>

        <div className="field city-field">
          <label>Город по умолчанию</label>
          <div className="row">
            <input
              value={cityQuery}
              placeholder="Начните вводить: Кемерово…"
              onChange={(e) => {
                setCityQuery(e.target.value);
                setShowHints(true);
              }}
              onFocus={() => setShowHints(true)}
              onBlur={() => {
                // delay so click on hint registers
                window.setTimeout(() => setShowHints(false), 150);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  searchCity();
                }
              }}
            />
            <button type="button" className="btn primary" onClick={searchCity}>
              Найти
            </button>
          </div>
          {showHints && hints.length > 0 && (
            <div className="city-hints">
              {hints.map((c) => (
                <button
                  key={c.name}
                  type="button"
                  className="city-hint"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyCity(c.name)}
                >
                  {c.name}
                </button>
              ))}
            </div>
          )}
          <div className="muted">
            Введите название и Enter / «Найти», либо выберите подсказку. Сейчас:{" "}
            <strong>{form.default_city}</strong> ({form.default_lat.toFixed(4)},{" "}
            {form.default_lon.toFixed(4)})
          </div>
        </div>

        <div className="field">
          <label>Провайдер карты</label>
          <select
            value={form.map_provider}
            onChange={(e) =>
              setForm({ ...form, map_provider: e.target.value as MapProviderId })
            }
          >
            <option value="yandex">Яндекс.Карты (нужен ключ)</option>
            <option value="dgis">2ГИС (нужен ключ)</option>
            <option value="osm">OpenStreetMap (без ключа, запасной)</option>
          </select>
          <div className="muted">
            Для Яндекса: ключ с developer.tech.yandex.ru (JavaScript API и HTTP Геокодер). Для
            2ГИС: platform.2gis.ru. Без ключа карта не загрузится — переключитесь на OSM
            временно.
          </div>
        </div>

        <div className="field">
          <label>API-ключ Яндекс (необязательно)</label>
          <input
            value={form.yandex_api_key}
            onChange={(e) => setForm({ ...form, yandex_api_key: e.target.value })}
            placeholder="для карт и поиска адреса Яндекса"
          />
        </div>

        <div className="field">
          <label>API-ключ 2ГИС (необязательно)</label>
          <input
            value={form.dgis_api_key}
            onChange={(e) => setForm({ ...form, dgis_api_key: e.target.value })}
            placeholder="для карт 2ГИС"
          />
        </div>

        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy}>
            Сохранить
          </button>
        </div>

        {message && (
          <div className="status-banner" style={{ whiteSpace: "pre-wrap" }}>
            {message}
          </div>
        )}

        <div className="status-banner">
          Индекс: ВО {stats?.water_points ?? 0}, карточек {stats?.cards ?? 0}, источников{" "}
          {stats?.sources ?? 0}
          {stats?.last_indexed_at ? ` · ${stats.last_indexed_at}` : ""}
        </div>
      </form>
    </div>
  );
}
