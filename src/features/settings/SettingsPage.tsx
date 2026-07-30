import { useEffect, useMemo, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import * as api from "../../shared/api";
import {
  CITIES,
  type AppSettings,
  type IndexStats,
  type MapPackageInfo,
  type MapPackProgress,
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
    map_provider: "local",
    yandex_api_key: "",
    dgis_api_key: "",
    default_city: form.default_city.trim(),
    local_map_city_id: form.local_map_city_id?.trim() || "",
    local_map_path: form.local_map_path?.trim() || "",
    infocard_api_base:
      form.infocard_api_base?.trim() || "https://infocardmchs.ru/api",
    infocard_enabled: !!form.infocard_enabled,
    infocard_login: form.infocard_login?.trim() || "",
  };
}

export function SettingsPage({ settings, stats, onSaved, onReindexed, onOpenMap }: Props) {
  const [form, setForm] = useState<AppSettings>({ ...settings });
  const [cityQuery, setCityQuery] = useState(settings.default_city || "");
  const [showHints, setShowHints] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageOk, setMessageOk] = useState(false);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [packages, setPackages] = useState<MapPackageInfo[]>([]);
  const [packCityName, setPackCityName] = useState(settings.default_city || "");
  const [packRadiusKm, setPackRadiusKm] = useState(12);
  const [packProgress, setPackProgress] = useState<MapPackProgress | null>(null);
  const [packDownloading, setPackDownloading] = useState(false);

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
    setForm({
      ...settings,
      default_city: settings.default_city || "",
      local_map_city_id: settings.local_map_city_id || "",
      local_map_path: settings.local_map_path || "",
    });
    setCityQuery(settings.default_city || "");
    // Не сбрасываем packCityName во время скачивания
  }, [settings]);

  useEffect(() => {
    void refreshSources();
    void refreshPackages();
  }, []);

  useEffect(() => {
    let unlistenProgress: (() => void) | undefined;
    let unlistenFinished: (() => void) | undefined;
    void (async () => {
      unlistenProgress = await listen<MapPackProgress>("map-pack-progress", (ev) => {
        setPackProgress(ev.payload);
        if (ev.payload.done) {
          setPackDownloading(false);
          if (ev.payload.error) {
            setMessage(ev.payload.error);
            setMessageOk(false);
          }
        } else {
          setPackDownloading(true);
        }
      });
      unlistenFinished = await listen<MapPackageInfo>("map-pack-finished", (ev) => {
        const info = ev.payload;
        setPackDownloading(false);
        setPackProgress((p) =>
          p
            ? { ...p, done: true, current: p.total, message: `Готово: ${info.tile_count} тайлов` }
            : null
        );
        void (async () => {
          try {
            const saved = await api.getSettings();
            await onSaved(saved);
            await refreshPackages();
            setForm((f) => ({
              ...f,
              ...saved,
              map_provider: "local",
              local_map_city_id: info.id,
              local_map_path: info.path,
              default_city: info.name,
              default_lat: info.lat,
              default_lon: info.lon,
              default_zoom: info.zoom,
            }));
            setCityQuery(info.name);
            setPackCityName(info.name);
            setMessage(
              `Пакет «${info.name}» готов: ${info.tile_count} тайлов.\n${info.path}`
            );
            setMessageOk(true);
          } catch (e) {
            setMessage(e instanceof Error ? e.message : String(e));
            setMessageOk(false);
          }
        })();
      });
    })();
    return () => {
      unlistenProgress?.();
      unlistenFinished?.();
    };
  }, [onSaved]);

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
      await ensureSaved();
      setMessage("Настройки сохранены.");
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
    setMessage(
      "Выберите файлы .kml / .kmz (можно несколько). После выбора идёт индексация — подождите."
    );
    setMessageOk(false);
    try {
      await ensureSaved();
      const report = await api.importKmzFiles();
      await onReindexed();
      await refreshSources();
      setMessage(
        `${report.hint}\nФайлы копируются в папку KMZ внутри базы и добавляются к уже загруженным.\nИмпортировано файлов: ${report.files_ok}, ИППВ в индексе: ${report.water_points}`
      );
      setMessageOk(report.files_ok > 0 || report.hint.includes("отменён"));
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  async function importKmzFromFolder() {
    setBusy(true);
    setMessage(
      "Выберите папку с файлами .kml/.kmz (например «Загрузки»). Это НЕ пакет карты OSM."
    );
    setMessageOk(false);
    try {
      await ensureSaved();
      const report = await api.importKmzFolder();
      await onReindexed();
      await refreshSources();
      setMessage(
        `${report.hint}\nИмпортировано файлов: ${report.files_ok}, ИППВ в индексе: ${report.water_points}`
      );
      setMessageOk(report.files_ok > 0 || report.hint.includes("отменён"));
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

  async function applyCity(name: string) {
    const local =
      CITIES.find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
      CITIES.find((c) => c.name.toLowerCase().includes(name.trim().toLowerCase()));
    if (local) {
      setForm((f) => ({
        ...f,
        default_city: local.name,
        default_lat: local.lat,
        default_lon: local.lon,
        default_zoom: local.zoom,
      }));
      setCityQuery(local.name);
      setPackCityName(local.name);
      setShowHints(false);
      return;
    }
    setBusy(true);
    setMessage(`Ищем город «${name}»…`);
    setMessageOk(false);
    try {
      const city = await api.resolveCity(name);
      setForm((f) => ({
        ...f,
        default_city: city.name,
        default_lat: city.lat,
        default_lon: city.lon,
        default_zoom: city.zoom,
      }));
      setCityQuery(city.name);
      setPackCityName(city.name);
      setShowHints(false);
      setMessage(
        `Город «${city.name}»: ${city.lat.toFixed(4)}, ${city.lon.toFixed(4)}`
      );
      setMessageOk(true);
    } catch (e) {
      setForm((f) => ({ ...f, default_city: name }));
      setCityQuery(name);
      setPackCityName(name);
      setShowHints(false);
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
    } finally {
      setBusy(false);
    }
  }

  function searchCity() {
    const q = cityQuery.trim();
    if (!q) return;
    void applyCity(q);
  }

  async function preparePack() {
    const name = packCityName.trim();
    if (!name) {
      setMessage("Введите название города для пакета карты");
      setMessageOk(false);
      return;
    }
    if (packDownloading) {
      setMessage("Уже идёт скачивание. Нажмите «Отменить» или дождитесь окончания.");
      setMessageOk(false);
      return;
    }
    setPackDownloading(true);
    setMessage(
      `Скачивание «${name}» запущено в фоне. Можно пользоваться программой — консоль не откроется.`
    );
    setMessageOk(true);
    setPackProgress({
      city_id: "",
      city_name: name,
      current: 0,
      total: 1,
      message: "Старт в фоне…",
      done: false,
      error: null,
    });
    try {
      await api.prepareMapPackage(name, packRadiusKm);
    } catch (e) {
      setPackDownloading(false);
      setMessage(e instanceof Error ? e.message : String(e));
      setMessageOk(false);
      setPackCityName(name);
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
            {onOpenMap && (
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
          <label>Infocard API (серверные карточки)</label>
          <input
            value={form.infocard_api_base || ""}
            onChange={(e) =>
              setForm({ ...form, infocard_api_base: e.target.value })
            }
            placeholder="https://infocardmchs.ru/api"
          />
          <label className="row" style={{ marginTop: 8, gap: 8 }}>
            <input
              type="checkbox"
              checked={!!form.infocard_enabled}
              onChange={(e) =>
                setForm({ ...form, infocard_enabled: e.target.checked })
              }
            />
            Включить режим Infocard (вкладка «Infocard»)
          </label>
        </div>

        <div className="field">
          <label>Водоисточники ИППВ (.kml / .kmz)</label>
          <div className="actions">
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void importKmz()}
            >
              Добавить файлы KML / KMZ…
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy}
              onClick={() => void importKmzFromFolder()}
            >
              Добавить из папки…
            </button>
            <button type="button" className="btn" disabled={busy} onClick={() => void reindex()}>
              Переиндексировать базу
            </button>
          </div>
          {sources.length === 0 ? (
            <div className="status-banner warn">
              Файлы водоисточников ещё не загружены — используйте кнопки выше
            </div>
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
              placeholder="Введите название города"
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
          {form.default_city ? (
            <div className="muted">
              Сейчас: <strong>{form.default_city}</strong> ({form.default_lat.toFixed(4)},{" "}
              {form.default_lon.toFixed(4)}). Поиск адресов ограничен радиусом{" "}
              <strong>50 км</strong> вокруг этого города.
            </div>
          ) : (
            <div className="muted">
              Укажите город для поиска адресов (радиус 50 км).
            </div>
          )}
        </div>

        <div className="field">
          <div className="row">
            <input
              value={packCityName}
              placeholder="Город для скачивания карты"
              onChange={(e) => setPackCityName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void preparePack();
                }
              }}
            />
            <input
              type="number"
              min={5}
              max={35}
              step={1}
              value={packRadiusKm}
              title="Радиус покрытия, км"
              style={{ maxWidth: 90 }}
              onChange={(e) => setPackRadiusKm(Number(e.target.value) || 16)}
            />
            <span className="muted" style={{ whiteSpace: "nowrap" }}>
              км
            </span>
          </div>
          <div className="actions" style={{ marginTop: "0.5rem" }}>
            <button
              type="button"
              className="btn primary"
              disabled={busy || packDownloading}
              onClick={() => void preparePack()}
            >
              {packDownloading ? "Скачивается…" : "Скачать"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!packDownloading}
              onClick={() => {
                void api.cancelMapPackage();
                setMessage("Отмена скачивания…");
                setMessageOk(false);
              }}
            >
              Отменить
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
              Активный пакет: <strong>{form.default_city || packCityName}</strong>
            </div>
          ) : (
            <div className="status-banner warn">
              Карта ещё не скачана. Введите город и нажмите «Скачать».
            </div>
          )}
          {packages.length > 0 && (
            <div className="muted" style={{ marginTop: 8 }}>
              Уже скачано:{" "}
              {packages
                .filter((p) => p.ready)
                .map((p) => p.name)
                .join(", ") || "—"}
            </div>
          )}
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
