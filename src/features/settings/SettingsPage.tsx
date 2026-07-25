import { useState } from "react";
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
    default_city: settings.default_city || "Москва",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

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
    setMessage("Сохранение и индексация…");
    try {
      await ensureSaved();
      const report = await api.reindex();
      await onReindexed();
      const errTail =
        report.errors.length > 0
          ? `\nОшибки:\n- ${report.errors.slice(0, 5).join("\n- ")}`
          : "";
      setMessage(
        `${report.hint}\nФайлов найдено: ${report.files_found}, точек: ${report.points_parsed}, карточек: ${report.cards}${errTail}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function importKmz() {
    setBusy(true);
    setMessage("Выберите файлы KML/KMZ…");
    try {
      await ensureSaved();
      const report = await api.importKmzFiles();
      await onReindexed();
      setMessage(
        `${report.hint}\nФайлов: ${report.files_found}, точек: ${report.points_parsed}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function applyCity(name: string) {
    const city = CITIES.find((c) => c.name === name);
    if (!city) {
      setForm((f) => ({ ...f, default_city: name }));
      return;
    }
    setForm((f) => ({
      ...f,
      default_city: city.name,
      default_lat: city.lat,
      default_lon: city.lon,
      default_zoom: city.zoom,
    }));
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
          <label>Путь к базе данных (FireData)</label>
          <div className="row">
            <input
              value={form.data_path}
              onChange={(e) => setForm({ ...form, data_path: e.target.value })}
              placeholder="D:\FireData"
            />
            <button type="button" className="btn" onClick={() => void pickFolder()}>
              Обзор…
            </button>
          </div>
          <div className="muted">
            Ожидаются папки <code>KMZ</code> / <code>Maps</code> и <code>KTP</code>. Либо
            загрузите файлы кнопкой ниже.
          </div>
        </div>

        <div className="field">
          <label>Импорт карты водоисточников</label>
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
            Импорт копирует выбранные файлы в папку KMZ внутри базы и сразу строит индекс.
          </div>
        </div>

        <div className="field">
          <label>Город по умолчанию</label>
          <select
            value={form.default_city || "Москва"}
            onChange={(e) => applyCity(e.target.value)}
          >
            {CITIES.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="muted">
            Карта откроется на этом городе. Координаты: {form.default_lat.toFixed(4)},{" "}
            {form.default_lon.toFixed(4)}
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
            <option value="osm">OpenStreetMap (работает сейчас, без ключа)</option>
            <option value="yandex">Яндекс (нужен ключ)</option>
            <option value="dgis">2ГИС (нужен ключ)</option>
          </select>
          <div className="muted">
            API-ключ нужен только для Яндекс/2ГИС: их тайлы, поиск адреса и геокодер. Без ключа
            карта уже работает через OpenStreetMap.
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
