import { useCallback, useEffect, useState } from "react";
import { MapPage } from "./features/map/MapPage";
import { CardsPage } from "./features/cards/CardsPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { AboutPage } from "./features/about/AboutPage";
import * as api from "./shared/api";
import type { AppSettings, IndexStats, TabId } from "./shared/types";
import type { UpdateManifest } from "./shared/api";

const DEFAULT_SETTINGS: AppSettings = {
  data_path: "",
  map_provider: "local",
  yandex_api_key: "",
  dgis_api_key: "",
  default_city: "",
  default_lat: 0,
  default_lon: 0,
  default_zoom: 12,
  local_map_city_id: "",
  local_map_path: "",
  infocard_api_base: "https://infocardmchs.ru/api",
  infocard_enabled: false,
  infocard_login: "",
  cards_mode: "local",
  markers_mode: "local",
  map_radius_km: 16,
};

export default function App() {
  const [tab, setTab] = useState<TabId>("map");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [stats, setStats] = useState<IndexStats | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openCardId, setOpenCardId] = useState<number | null>(null);
  const [updateOffer, setUpdateOffer] = useState<UpdateManifest | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.getSettings(), api.getStats()]);
      setSettings(s);
      setStats(st);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void api
        .checkForUpdates()
        .then((r) => {
          if (r.updateAvailable && r.latest) setUpdateOffer(r.latest);
        })
        .catch(() => {
          /* offline / no manifest — silently ignore */
        });
    }, 2000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        document.getElementById("global-search")?.focus();
      }
      if (e.key === "F2") {
        e.preventDefault();
        setTab("map");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  async function applyUpdate() {
    if (!updateOffer) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      await api.downloadAndApplyUpdate(updateOffer.portable.url, updateOffer.portable.sha256);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : String(e));
      setUpdateBusy(false);
    }
  }

  if (!ready) {
    return <div className="empty">Загрузка Пожарного Атласа…</div>;
  }

  const cardsMode = settings.cards_mode || "local";
  // Локальный просмотр файлов ИК — при local/both, или при открытии карточки с карты.
  const showCardsTab = cardsMode === "local" || cardsMode === "both";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Пожарный Атлас</strong>
        </div>
        <nav className="tabs">
          <button className={`tab ${tab === "map" ? "active" : ""}`} onClick={() => setTab("map")}>
            Карта
          </button>
          {(showCardsTab || openCardId != null) && (
            <button
              className={`tab ${tab === "cards" ? "active" : ""}`}
              onClick={() => setTab("cards")}
            >
              Информационные карточки
            </button>
          )}
          <button
            className={`tab ${tab === "settings" ? "active" : ""}`}
            onClick={() => setTab("settings")}
          >
            Настройки
          </button>
          <button
            className={`tab ${tab === "about" ? "active" : ""}`}
            onClick={() => setTab("about")}
          >
            О программе
          </button>
        </nav>
        <div className="topbar-stats">
          {stats
            ? `ИППВ: ${stats.water_points} · Карточки: ${stats.cards} · Источники: ${stats.sources}`
            : "Нет данных индекса"}
        </div>
      </header>

      {error && <div className="status-banner">{error}</div>}

      {updateOffer && !updateDismissed && (
        <div className="update-banner">
          <div className="update-banner-text">
            <strong>Доступна версия {updateOffer.version}</strong>
            {updateOffer.notes ? <span> — {updateOffer.notes}</span> : null}
            {updateError ? <div className="error-text">{updateError}</div> : null}
          </div>
          <div className="update-banner-actions">
            <button
              type="button"
              className="btn primary"
              disabled={updateBusy}
              onClick={() => void applyUpdate()}
            >
              {updateBusy ? "Загрузка…" : "Обновить"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={updateBusy}
              onClick={() => setUpdateDismissed(true)}
            >
              Позже
            </button>
          </div>
        </div>
      )}

      <main className="main">
        {tab === "map" && (
          <MapPage
            settings={settings}
            onOpenCard={(id) => {
              setOpenCardId(id);
              setTab("cards");
            }}
          />
        )}
        {tab === "cards" && (showCardsTab || openCardId != null) && (
          <CardsPage initialCardId={openCardId} />
        )}
        {tab === "settings" && (
          <SettingsPage
            settings={settings}
            stats={stats}
            onSaved={async (next) => {
              setSettings(next);
              await refresh();
            }}
            onReindexed={async () => {
              await refresh();
            }}
            onOpenMap={() => setTab("map")}
          />
        )}
        {tab === "about" && <AboutPage />}
      </main>
    </div>
  );
}
