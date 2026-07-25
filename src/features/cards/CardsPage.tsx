import { useEffect, useState } from "react";
import * as api from "../../shared/api";
import type { Card, CardFile } from "../../shared/types";

interface Props {
  initialCardId?: number | null;
}

function fileLabel(kind: string): string {
  switch (kind) {
    case "word":
      return "Word";
    case "visio":
      return "Visio";
    case "pdf":
      return "PDF";
    case "jpg":
      return "Фото";
    default:
      return "Файл";
  }
}

export function CardsPage({ initialCardId = null }: Props) {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [activeFile, setActiveFile] = useState<CardFile | null>(null);
  const [preview, setPreview] = useState<{ mime: string; dataUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        const list = await api.listCards(query, 100);
        setCards(list);
      })();
    }, 180);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => {
    if (initialCardId == null) return;
    void (async () => {
      const full = await api.getCard(initialCardId);
      if (full) {
        setSelected(full);
        setActiveFile(null);
        setPreview(null);
        await api.addHistory("card", full.id, full.title);
      }
    })();
  }, [initialCardId]);

  async function openCard(card: Card) {
    setBusy(true);
    setError(null);
    try {
      const full = await api.getCard(card.id);
      if (!full) {
        setError("Карточка не найдена в индексе");
        return;
      }
      setSelected(full);
      setActiveFile(null);
      setPreview(null);
      await api.addHistory("card", full.id, full.title);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file: CardFile) {
    setActiveFile(file);
    setError(null);
    setBusy(true);
    try {
      // Images can preview; Office docs open in Word/Visio via OS
      if (file.kind === "jpg") {
        const b64 = await api.readFileBase64(file.path);
        const lower = file.path.toLowerCase();
        const mime = lower.endsWith(".png")
          ? "image/png"
          : lower.endsWith(".webp")
            ? "image/webp"
            : "image/jpeg";
        setPreview({ mime, dataUrl: `data:${mime};base64,${b64}` });
        return;
      }
      if (file.kind === "pdf") {
        const b64 = await api.readFileBase64(file.path);
        setPreview({
          mime: "application/pdf",
          dataUrl: `data:application/pdf;base64,${b64}`,
        });
        return;
      }
      setPreview(null);
      await api.openPath(file.path);
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)) +
          "\nЕсли файл в облаке Z: — откройте папку и дождитесь скачивания, затем снова «Открыть»."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel cards-layout">
      <aside className="side">
        <input
          className="search-box"
          placeholder="Название, адрес, номер…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="results">
          {cards.length === 0 && <div className="empty">Карточки не найдены</div>}
          {cards.map((c) => (
            <button
              key={c.id}
              className={`result-item ${selected?.id === c.id ? "active" : ""}`}
              onClick={() => void openCard(c)}
            >
              <div className="title">
                <span className="badge card">ИК</span>
                {c.title}
              </div>
              <div className="meta">
                {[c.number && `№${c.number}`, c.address, c.district]
                  .filter(Boolean)
                  .join(" · ") || c.folder_path}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="viewer">
        {!selected && <div className="empty">Выберите карточку слева</div>}
        {selected && (
          <>
            <h2 style={{ marginTop: 0 }}>{selected.title}</h2>
            <p className="muted">
              {[selected.number && `№${selected.number}`, selected.address, selected.district]
                .filter(Boolean)
                .join(" · ") || "Адрес не указан"}
            </p>

            <div className="actions" style={{ marginBottom: "0.75rem" }}>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void api.openFolder(selected.folder_path)}
              >
                Открыть папку карточки
              </button>
            </div>

            <h3 style={{ margin: "0.5rem 0" }}>Документы</h3>
            {selected.files.length === 0 && (
              <div className="status-banner">
                В индексе нет файлов. Откройте папку вручную — возможно, облако ещё не скачало
                содержимое.
              </div>
            )}

            <div className="doc-rows">
              {selected.files.map((f) => (
                <div key={f.id} className="doc-row">
                  <div>
                    <strong>
                      {fileLabel(f.kind)}: {f.name}
                    </strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {f.path}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void openFile(f)}
                    >
                      Открыть
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <div className="status-banner" style={{ whiteSpace: "pre-wrap", marginTop: "0.75rem" }}>
                {error}
              </div>
            )}

            {activeFile && (activeFile.kind === "word" || activeFile.kind === "visio") && (
              <div className="status-banner" style={{ marginTop: "0.75rem" }}>
                Файл открывается во внешней программе (Word / Visio). Если ничего не произошло —
                файл ещё в облаке: нажмите «Открыть папку карточки».
              </div>
            )}

            {preview?.mime.startsWith("image/") && (
              <img
                src={preview.dataUrl}
                alt={activeFile?.name || "preview"}
                style={{ marginTop: "1rem" }}
              />
            )}
            {preview?.mime === "application/pdf" && (
              <iframe
                title="pdf"
                src={preview.dataUrl}
                style={{ width: "100%", height: "70vh", border: 0, marginTop: "1rem" }}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}
