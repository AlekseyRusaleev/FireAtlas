import { useEffect, useMemo, useState } from "react";
import * as api from "../../shared/api";
import {
  CITIES,
  type AppSettings,
  type IndexStats,
  type MapProviderId,
  type SourceInfo,
} from "../../shared/types";

interface Props {
  settings: AppSettings;
  stats: IndexStats | null;
  onSaved: (settings: AppSettings) => Promise<void>;
  onReindexed: () => Promise<void>;
  onOpenMap?: () => void;
}

function normalize(form: AppSettings): AppSettings {
  return {
    ...form,
    data_path: form.data_path.trim(),
    yandex_api_key: form.yandex_api_key.trim(),
    dgis_api_key: form.dgis_api_key.trim(),
    default_city: form.default_city.trim() || "Кемерово",
  };
}

export function SettingsPage({ settings, stats, onSaved, onReindexed, onOpenMap }: Props) {
  const [form, setForm] = useState<AppSettings>({
    ...settings,
    default_city: settings.default_city || "Кемерово",
  });
  const [cityQuery, setCityQuery] = useState(settings.default_city || "");
  const [showHints, setShowHints] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageOk, setMessageOk] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);

  async function refreshSources() {
    try {
      setSources(await api.listSources());
    } catch {
      /* список источников не критичен при старте */
    }
  }

  useEffect(() => {
    setForm({
      ...settings,
      default_city: settings.default_city || "Кемерово",
    });
    setCityQuery(settings.default_city || "");
  }, [settings]);

  useEffect(() => {
    void refreshSources();
  }, []);

  const dirty = useMemo(() => {
    const a = normalize(form);
    const b = normalize(settings);
    return JSON.stringify(a) !== JSON.stringify(b);
  }, [form, settings]);

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
    const next = normalize(form);
    const saved = await api.saveSettings(next);
    await onSaved(saved);
    setForm(saved);
    return saved;
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    setMessageOk(false);
    try {
      const saved = await ensureSaved();
      const parts = ["Настройки сохранены."];
      if (saved.map_provider === "yandex") {
        if (saved.yandex_api_key) {
          parts.push(
            `Ключ Яндекса сохранён (${saved.yandex_api_key.slice(0, 8)}…). Откройте вкладку «Карта».`
          );
        } else {
          parts.push("Ключ Яндекса пустой — карта не загрузится. Вставьте ключ и снова нажмите «Сохранить».");
        }
      }
      setMessage(parts.join(" "));
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function reindex() {
    setBusy(true);
    setMessage("Сохранение и индексация… Не закрывайте окно.");
    setMessageOk(false);
    try {
      await ensureSaved();
      const report = await api.reindex();
      await onReindexed();
      await refreshSources();
      const errTail =
        report.errors.length > 0
          ? `\nОшибки:\n- ${report.errors.slice(0, 5).join("\n- ")}`
          : "";
      setMessage(
        `${report.hint}\nФайлов карт: ${report.files_found}, точек: ${report.points_parsed}, карточек: ${report.cards}${errTail}`
      );
      setMessageOk(report.files_failed === 0);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function importKmz() {
    setBusy(true);
    setMessage("Выберите файлы KML/KMZ… После выбора идёт индексация — подождите.");
    setMessageOk(false);
    try {
      await ensureSaved();
      const report = await api.importKmzFiles();
      await onReindexed();
      await refreshSources();
      setMessage(
        `${report.hint}\nФайлы добавляются параллельно к уже загруженным (не затирают другие).\nИмпортировано файлов: ${report.files_ok}, ИППВ в индексе: ${report.water_points}`
      );
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function removeSource(id: number, name: string) {
    if (!window.confirm(`Удалить файл «${name}» из индекса вместе с его метками ИППВ?`)) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      setSources(await api.deleteSource(id));
      await onReindexed();
      setMessage(`Файл «${name}» удалён из индекса. Остальные файлы не затронуты.`);
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  function applyCity(name: string) {
    const city =
      CITIES.find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
      CITIES.find((c) => c.name.toLowerCase().includes(name.trim().toLowerCase()));
    if (!city) {
      setForm((f) => ({ ...f, default_city: name }));
      setCityQuery(name);
      setShowHints(false);
      setMessage(
        `Город «${name}» сохранён как название. Выберите город из подсказок, чтобы задать координаты карты.`
      );
      setMessageOk(false);
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
        <div className="settings-head">
          <div>
            <h2 style={{ margin: 0 }}>Настройки</h2>
            <div className="muted" style={{ marginTop: 4 }}>
              {dirty
                ? "Есть несохранённые изменения — нажмите «Сохранить»."
                : "Все изменения сохранены."}
            </div>
          </div>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={busy}>
              {busy ? "Сохранение…" : "Сохранить"}
            </button>
            {messageOk && form.map_provider === "yandex" && form.yandex_api_key.trim() && onOpenMap && (
              <button type="button" className="btn" onClick={onOpenMap}>
                Открыть карту
              </button>
            )}
          </div>
        </div>

        {message && (
          <div
            className={`status-banner ${messageOk ? "ok" : "warn"}`}
            style={{ whiteSpace: "pre-wrap" }}
          >
            {message}
          </div>
        )}

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
            <code>Информационные карточки</code> (или <code>KTP</code>). Можно указать сам диск
            Yandex IPSCH (Z:).
          </div>
        </div>

        <div className="field">
          <label>ИППВ (KML/KMZ)</label>
          <div className="actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void importKmz()}
            >
              Добавить KML / KMZ…
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void reindex()}>
              Переиндексировать базу
            </button>
          </div>
          <div className="muted">
            Новый импорт <strong>добавляет</strong> файлы к уже загруженным. Чтобы заменить файл —
            удалите старый в списке ниже и импортируйте новый. Повторный импорт того же пути
            обновляет только его точки.
          </div>
          {sources.length === 0 ? (
            <div className="status-banner">Файлы карт ещё не загружены</div>
          ) : (
            <div className="source-list">
              {sources.map((s) => (
                <div key={s.id} className="source-row">
                  <div>
                    <strong>{s.file_name}</strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {s.point_count} точек · {s.path}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy}
                    onClick={() => void removeSource(s.id, s.file_name)}
                  >
                    Удалить
                  </button>
                </div>
              ))}
            </div>
          )}
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
            {form.default_lon.toFixed(4)}). Поиск адресов и объектов ограничен радиусом{" "}
            <strong>50 км</strong> вокруг этого города.
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
            Без ключа Яндекса/2ГИС карта не загрузится — временно переключитесь на OSM, чтобы
            работать с ИППВ.
          </div>
        </div>

        <div className="field">
          <label>API-ключ Яндекс</label>
          <div className="row">
            <input
              value={form.yandex_api_key}
              onChange={(e) => setForm({ ...form, yandex_api_key: e.target.value })}
              placeholder="вставьте ключ и нажмите «Сохранить»"
              spellCheck={false}
              autoComplete="off"
            />
            <button className="btn primary" type="submit" disabled={busy}>
              Сохранить
            </button>
          </div>
          <div className="muted">
            Сервис на developer.tech.yandex.ru: <strong>«JavaScript API и HTTP Геокодер»</strong>.
            После сохранения откройте вкладку «Карта». Если карта пустая — проверьте, что у ключа
            разрешён этот сервис и нет ограничений по HTTP Referer.
          </div>
          {form.yandex_api_key.trim() ? (
            <div className="status-banner ok">
              Ключ введён ({form.yandex_api_key.trim().length} символов)
              {dirty ? " — ещё не сохранён" : " — сохранён в настройках"}
            </div>
          ) : (
            <div className="status-banner warn">Ключ не введён</div>
          )}
        </div>

        <div className="field">
          <label>API-ключ 2ГИС (необязательно)</label>
          <input
            value={form.dgis_api_key}
            onChange={(e) => setForm({ ...form, dgis_api_key: e.target.value })}
            placeholder="для карт 2ГИС"
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="actions">
          <button className="btn primary" type="submit" disabled={busy}>
            Сохранить
          </button>
          {onOpenMap && (
            <button type="button" className="btn" onClick={onOpenMap}>
              Перейти к карте
            </button>
          )}
        </div>

        <div className="status-banner">
          Индекс: ИППВ {stats?.water_points ?? 0}, карточек {stats?.cards ?? 0}, источников{" "}
          {stats?.sources ?? 0}
          {stats?.last_indexed_at ? ` · ${stats.last_indexed_at}` : ""}
        </div>
      </form>
    </div>
  );
}
