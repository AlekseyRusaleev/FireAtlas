import { useCallback, useEffect, useState } from "react";
import * as api from "../../shared/api";
import type { UpdateCheckResult, UpdateManifest } from "../../shared/api";

export function AboutPage() {
  const [version, setVersion] = useState("…");
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [latest, setLatest] = useState<UpdateManifest | null>(null);

  useEffect(() => {
    void api.getAppVersion().then(setVersion).catch(() => setVersion("неизвестно"));
  }, []);

  const check = useCallback(async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    setLatest(null);
    try {
      const result: UpdateCheckResult = await api.checkForUpdates();
      if (result.updateAvailable && result.latest) {
        setLatest(result.latest);
        setMessage(`Доступна версия ${result.latest.version}`);
      } else {
        setMessage(`У вас актуальная версия (${result.currentVersion})`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const apply = useCallback(async () => {
    if (!latest) return;
    setApplying(true);
    setError(null);
    try {
      await api.downloadAndApplyUpdate(latest.portable.url, latest.portable.sha256);
      setMessage("Обновление загружено. Программа перезапустится…");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setApplying(false);
    }
  }, [latest]);

  return (
    <div className="panel about-layout">
      <h2 style={{ marginTop: 0 }}>О программе</h2>
      <div className="about-card">
        <p>Приложение создано для работы пунктов связи пожарных подразделений</p>
        <p>
          Версия: <strong>{version}</strong>
        </p>
        <p>Разработчик Русалеев А.В. г. Кемерово.</p>
        <p className="about-gap">По вопросам и предложениям</p>
        <p>
          Telegram: <strong>AlekseyRus42</strong>
        </p>
        <p>
          email: <a href="mailto:leshqa90@yandex.ru">leshqa90@yandex.ru</a>
        </p>

        <div className="about-update">
          <button type="button" className="btn" disabled={busy || applying} onClick={() => void check()}>
            {busy ? "Проверка…" : "Проверить обновления"}
          </button>
          {latest && (
            <button
              type="button"
              className="btn primary"
              disabled={applying}
              onClick={() => void apply()}
            >
              {applying ? "Загрузка обновления…" : `Обновить до ${latest.version}`}
            </button>
          )}
        </div>
        {message && <p className="about-update-msg">{message}</p>}
        {latest?.notes && <p className="muted">{latest.notes}</p>}
        {error && <p className="error-text">{error}</p>}
      </div>
    </div>
  );
}
