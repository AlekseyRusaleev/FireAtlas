import { useEffect, useState } from "react";
import * as api from "../../shared/api";
import type { Card, CardFile } from "../../shared/types";

export function CardsPage() {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [activeFile, setActiveFile] = useState<CardFile | null>(null);
  const [preview, setPreview] = useState<{ mime: string; dataUrl: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        const list = await api.listCards(query, 100);
        setCards(list);
      })();
    }, 180);
    return () => window.clearTimeout(t);
  }, [query]);

  async function openCard(card: Card) {
    const full = await api.getCard(card.id);
    if (!full) return;
    setSelected(full);
    await api.addHistory("card", full.id, full.title);
    const first = full.files[0] || null;
    setActiveFile(first);
    if (first) await loadPreview(first);
    else setPreview(null);
  }

  async function loadPreview(file: CardFile) {
    setActiveFile(file);
    setError(null);
    try {
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPreview(null);
    }
  }

  return (
    <div className="panel cards-layout">
      <aside className="side">
        <input
          className="search-box"
          placeholder="Название, адрес, номер, район…"
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
                <span className="badge card">КТП</span>
                {c.title}
              </div>
              <div className="meta">
                {[c.number, c.address, c.district].filter(Boolean).join(" · ") || c.folder_path}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section className="viewer">
        {!selected && (
          <div className="empty">Выберите карточку тушения слева</div>
        )}
        {selected && (
          <>
            <h2 style={{ marginTop: 0 }}>{selected.title}</h2>
            <p className="muted">
              {[selected.number, selected.address, selected.district].filter(Boolean).join(" · ") ||
                "Адрес не указан"}
            </p>
            <div className="file-list">
              {selected.files.map((f) => (
                <button
                  key={f.id}
                  className={`btn ${activeFile?.id === f.id ? "primary" : ""}`}
                  onClick={() => void loadPreview(f)}
                >
                  {f.kind.toUpperCase()}: {f.name}
                </button>
              ))}
              {selected.files.length === 0 && (
                <div className="muted">В папке нет Word / Visio / JPG / PDF</div>
              )}
            </div>

            {error && <div className="status-banner">{error}</div>}

            {activeFile && (activeFile.kind === "word" || activeFile.kind === "visio") && (
              <div className="status-banner">
                Встроенный рендер {activeFile.kind === "word" ? "Word" : "Visio"} в MVP
                ограничен. Можно открыть файл во внешней программе.
                <div className="actions" style={{ marginTop: "0.6rem" }}>
                  <button className="btn primary" onClick={() => void api.openPath(activeFile.path)}>
                    Открыть внешне
                  </button>
                </div>
              </div>
            )}

            {preview?.mime.startsWith("image/") && (
              <img src={preview.dataUrl} alt={activeFile?.name || "preview"} />
            )}
            {preview?.mime === "application/pdf" && (
              <iframe title="pdf" src={preview.dataUrl} style={{ width: "100%", height: "70vh", border: 0 }} />
            )}
          </>
        )}
      </section>
    </div>
  );
}
