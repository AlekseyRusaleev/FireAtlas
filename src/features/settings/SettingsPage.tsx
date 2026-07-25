import { useState } from "react";
import * as api from "../../shared/api";
import type { AppSettings, IndexStats, MapProviderId } from "../../shared/types";

interface Props {
  settings: AppSettings;
  stats: IndexStats | null;
  onSaved: (settings: AppSettings) => Promise<void>;
  onReindexed: () => Promise<void>;
}

export function SettingsPage({ settings, stats, onSaved, onReindexed }: Props) {
  const [form, setForm] = useState<AppSettings>(settings);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function pickFolder() {
    const path = await api.pickDataFolder();
    if (path) setForm((f) => ({ ...f, data_path: path }));
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const saved = await api.saveSettings(form);
      await onSaved(saved);
      setMessage("Настройки сохранены");
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    setBusy(true);
    setMessage("Индексация…");
    try {
      const st = await api.reindex();
      await onReindexed();
      setMessage(
        `Готово: ВО ${st.water_points}, карточек ${st.cards}, источников ${st.sources}`
      );
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
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
          <div className="muted">Ожидаемые папки: KMZ (или Maps), KTP</div>
        </div>

        <div className="field">
          <label>Провайдер карты</label>
          <select
            value={form.map_provider}
            onChange={(e) =>
              setForm({ ...form, map_provider: e.target.value as MapProviderId })
            }
          >
            <option value="yandex">Яндекс (ключ ниже)</option>
            <option value="dgis">2ГИС (ключ ниже)</option>
            <option value="osm">OpenStreetMap (без ключа)</option>
          </select>
          <div className="muted">
            Сейчас в UI работает OSM/Leaflet. Яндекс и 2ГИС подключим после появления ключей —
            поля уже сохраняются.
          </div>
        </div>

        <div className="field">
          <label>API-ключ Яндекс</label>
          <input
            value={form.yandex_api_key}
            onChange={(e) => setForm({ ...form, yandex_api_key: e.target.value })}
            placeholder="вставьте ключ"
          />
        </div>

        <div className="field">
          <label>API-ключ 2ГИС</label>
          <input
            value={form.dgis_api_key}
            onChange={(e) => setForm({ ...form, dgis_api_key: e.target.value })}
            placeholder="вставьте ключ"
          />
        </div>

        <div className="field">
          <label>Центр карты по умолчанию (широта / долгота / zoom)</label>
          <div className="row">
            <input
              type="number"
              step="0.0001"
              value={form.default_lat}
              onChange={(e) =>
                setForm({ ...form, default_lat: Number(e.target.value) })
              }
            />
            <input
              type="number"
              step="0.0001"
              value={form.default_lon}
              onChange={(e) =>
                setForm({ ...form, default_lon: Number(e.target.value) })
              }
            />
            <input
              type="number"
              value={form.default_zoom}
              onChange={(e) =>
                setForm({ ...form, default_zoom: Number(e.target.value) })
              }
            />
          </div>
        </div>

        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy}>
            Сохранить
          </button>
          <button className="btn" type="button" disabled={busy} onClick={() => void reindex()}>
            Переиндексировать
          </button>
        </div>

        {message && <div className="status-banner">{message}</div>}

        <div className="status-banner">
          Индекс: ВО {stats?.water_points ?? 0}, карточек {stats?.cards ?? 0}, источников{" "}
          {stats?.sources ?? 0}
          {stats?.last_indexed_at ? ` · ${stats.last_indexed_at}` : ""}
        </div>
      </form>
    </div>
  );
}
