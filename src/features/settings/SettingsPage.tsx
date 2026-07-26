import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../../shared/api";
import {
  CITIES,
  type AppSettings,
  type IndexStats,
  type MapCity,
  type MapPackageInfo,
  type MapPackProgress,
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
    local_map_city_id: form.local_map_city_id?.trim() || "",
    local_map_path: form.local_map_path?.trim() || "",
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
  const [mapCities, setMapCities] = useState<MapCity[]>([]);
  const [packages, setPackages] = useState<MapPackageInfo[]>([]);
  const [packCityId, setPackCityId] = useState(settings.local_map_city_id || "kemerovo");
  const [packProgress, setPackProgress] = useState<MapPackProgress | null>(null);

  async function refreshSources() {
    try {
      setSources(await api.listSources());
    } catch {
      /* список источников не критичен при старте */
    }
  }

  async function refreshPackages() {
    try {
      setPackages(await api.listMapPackages());
    } catch {
      setPackages([]);
    }
  }

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.listMapCities();
        setMapCities(list);
        setPackCityId((prev) => prev || list[0]?.id || "kemerovo");
      } catch {
        /* ignore */
      }
    })();
  }, []);

  useEffect(() => {
    setForm({
      ...settings,
      default_city: settings.default_city || "Кемерово",
      local_map_city_id: settings.local_map_city_id || "kemerovo",
      local_map_path: settings.local_map_path || "",
    });
    setCityQuery(settings.default_city || "");
    setPackCityId(settings.local_map_city_id || "kemerovo");
  }, [settings]);

  useEffect(() => {
    void refreshSources();
    void refreshPackages();
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void (async () => {
      unlisten = await listen<MapPackProgress>("map-pack-progress", (ev) => {
        setPackProgress(ev.payload);
      });
    })();
    return () => {
      unlisten?.();
    };
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

  async function preparePack() {
    setBusy(true);
    setMessage("Подготовка пакета карты… Нужен интернет. Не закрывайте окно.");
    setMessageOk(false);
    setPackProgress(null);
    try {
      await ensureSaved();
      const info = await api.prepareMapPackage(packCityId);
      await onSaved(await api.getSettings());
      await refreshPackages();
      setForm((f) => ({
        ...f,
        map_provider: "local",
        local_map_city_id: info.id,
        local_map_path: info.path,
        default_city: info.name,
        default_lat: info.lat,
        default_lon: info.lon,
        default_zoom: info.zoom,
      }));
      setMessage(
        `Пакет «${info.name}» готов: ${info.tile_count} тайлов.\nПуть: ${info.path}\nПровайдер переключён на локальную карту.`
      );
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function importPack() {
    setBusy(true);
    setMessageOk(false);
    try {
      await ensureSaved();
      const info = await api.importMapPackageZip();
      await onSaved(await api.getSettings());
      await refreshPackages();
      setForm((f) => ({
        ...f,
        map_provider: "local",
        local_map_city_id: info.id,
        local_map_path: info.path,
        default_city: info.name,
        default_lat: info.lat,
        default_lon: info.lon,
        default_zoom: info.zoom,
      }));
      setMessage(`Загружен пакет «${info.name}» (${info.tile_count} тайлов).`);
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function pickPackFolder() {
    setBusy(true);
    try {
      const info = await api.pickMapPackageFolder();
      await onSaved(await api.getSettings());
      await refreshPackages();
      setForm((f) => ({
        ...f,
        map_provider: "local",
        local_map_city_id: info.id,
        local_map_path: info.path,
        default_city: info.name,
        default_lat: info.lat,
        default_lon: info.lon,
        default_zoom: info.zoom,
      }));
      setMessage(`Выбран пакет «${info.name}».`);
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function exportPack() {
    setBusy(true);
    try {
      const path = await api.exportMapPackageZip(form.local_map_path || undefined);
      setMessage(`Пакет сохранён: ${path}\nЕго можно передать в другой город.`);
      setMessageOk(true);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
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
              placeholder="Путь к папке базы"
            />
            <button type="button" className="btn" onClick={() => void pickFolder()}>
              Обзор…
            </button>
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
            <option value="local">Локальная OSM (пакет города)</option>
            <option value="yandex">Яндекс.Карты (нужен ключ)</option>
            <option value="dgis">2ГИС (нужен ключ)</option>
            <option value="osm">OpenStreetMap онлайн</option>
          </select>
        </div>

        <div className="field">
          <label>Пакет локальной карты города</label>
          <select
            value={packCityId}
            onChange={(e) => setPackCityId(e.target.value)}
          >
            {mapCities.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="actions" style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void preparePack()}
            >
              Скачать / подготовить пакет
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void api.cancelMapPackage()}
            >
              Отменить
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void importPack()}
            >
              Загрузить ZIP…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => void pickPackFolder()}
            >
              Выбрать папку…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !form.local_map_path}
              onClick={() => void exportPack()}
            >
              Сохранить ZIP…
            </button>
          </div>
          {packProgress && !packProgress.done && (
            <div className="status-banner">
              {packProgress.city_name}: {packProgress.current}/{packProgress.total} —{" "}
              {packProgress.message}
              <div
                style={{
                  marginTop: 6,
                  height: 6,
                  background: "#3a4450",
                  borderRadius: 4,
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${Math.min(
                      100,
                      (100 * packProgress.current) / Math.max(1, packProgress.total)
                    )}%`,
                    height: "100%",
                    background: "var(--accent)",
                  }}
                />
              </div>
            </div>
          )}
          {form.local_map_path ? (
            <div className="status-banner ok">
              Активный пакет: <strong>{form.default_city}</strong> — {form.local_map_path}
            </div>
          ) : (
            <div className="status-banner warn">
              Пакет не выбран. Выберите город и нажмите «Скачать / подготовить пакет» (нужен
              интернет один раз).
            </div>
          )}
          {packages.length > 0 && (
            <div className="muted" style={{ marginTop: 8 }}>
              Уже скачано:{" "}
              {packages
                .filter((p) => p.ready)
                .map((p) => p.name)
                .join(", ") || "—"}
              . Чтобы переключиться — выберите город и снова «Скачать» (догрузит недостающее) или
              укажите папку пакета.
            </div>
          )}
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
