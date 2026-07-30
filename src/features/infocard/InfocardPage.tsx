import { useEffect, useState } from "react";
import * as api from "../../shared/api";
import type { AppSettings } from "../../shared/types";

interface Props {
  settings: AppSettings;
}

export function InfocardPage({ settings }: Props) {
  const [login, setLogin] = useState(settings.infocard_login || "");
  const [password, setPassword] = useState("");
  const [sessionLogin, setSessionLogin] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<api.InfocardFileHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api.infocardGetSession().then((s) => {
      setSessionLogin(s.access_token ? s.login || settings.infocard_login : null);
    });
  }, [settings.infocard_login]);

  async function doLogin() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.infocardLogin(login, password);
      setSessionLogin(s.login);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function doLogout() {
    await api.infocardLogout();
    setSessionLogin(null);
    setHits([]);
  }

  async function doSearch() {
    setBusy(true);
    setError(null);
    try {
      setHits(await api.infocardSearchFiles(query, 50));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openPdf(id: string) {
    setBusy(true);
    setError(null);
    try {
      await api.infocardOpenPdf(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 16, maxWidth: 720 }}>
      <h2>Infocard (сервер)</h2>
      <p style={{ opacity: 0.75, fontSize: 14 }}>
        Поиск и открытие PDF с сервера Infocard. Локальные карточки и ИППВ не затрагиваются.
        API: {settings.infocard_api_base || "https://infocardmchs.ru/api"}
      </p>

      {!sessionLogin ? (
        <div style={{ display: "grid", gap: 8, maxWidth: 360 }}>
          <input
            placeholder="Логин"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          <input
            placeholder="Пароль"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <button disabled={busy} onClick={() => void doLogin()}>
            Войти
          </button>
        </div>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          <div>
            Вошли как <b>{sessionLogin}</b>{" "}
            <button onClick={() => void doLogout()}>Выйти</button>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              style={{ flex: 1 }}
              placeholder="Поиск файлов…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void doSearch()}
            />
            <button disabled={busy} onClick={() => void doSearch()}>
              Найти
            </button>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {hits.map((h) => (
              <li
                key={h.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "8px 0",
                  borderBottom: "1px solid #ddd",
                }}
              >
                <span>
                  {h.name}{" "}
                  <small style={{ opacity: 0.6 }}>{h.status || ""}</small>
                </span>
                <button disabled={busy} onClick={() => void openPdf(h.id)}>
                  PDF
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && (
        <p style={{ color: "#b00020", marginTop: 12 }}>{error}</p>
      )}
    </div>
  );
}
