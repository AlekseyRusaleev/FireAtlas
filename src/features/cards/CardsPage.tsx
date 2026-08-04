import { useEffect, useRef, useState } from "react";
import * as api from "../../shared/api";
import { PdfViewer } from "../../shared/PdfViewer";
import type { Card, CardFile } from "../../shared/types";

interface Props {
  initialCardId?: number | null;
}

function fileExt(file: CardFile): string {
  const fromName = file.name.split(".").pop()?.toLowerCase() ?? "";
  const fromPath = file.path.split(/[/\\]/).pop()?.split(".").pop()?.toLowerCase() ?? "";
  return fromName || fromPath;
}

function fileLabel(file: CardFile): string {
  const ext = fileExt(file);
  switch (file.kind) {
    case "word":
      return ext === "docx" ? "Word (DOCX)" : ext === "doc" ? "Word (DOC)" : `Word (${ext || "?"})`;
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

/** Что реально можно показать внутри окна приложения. */
function canPreviewInApp(file: CardFile): boolean {
  if (file.kind === "jpg" || file.kind === "pdf") return true;
  if (file.kind === "word" && fileExt(file) === "docx") return true;
  return false;
}

function fileStem(name: string): string {
  const idx = name.lastIndexOf(".");
  return (idx >= 0 ? name.slice(0, idx) : name).trim().toLowerCase();
}

function findPdfFallback(file: CardFile, files: CardFile[]): CardFile | null {
  const pdfs = files.filter((item) => item.kind === "pdf");
  if (pdfs.length === 0) return null;
  const stem = fileStem(file.name);
  return pdfs.find((item) => fileStem(item.name) === stem) ?? pdfs[0] ?? null;
}

function previewHint(file: CardFile, files: CardFile[]): string {
  if (canPreviewInApp(file)) return "откроется в окне программы";
  if (findPdfFallback(file, files)) return "для просмотра откроется PDF этой карточки";
  if (file.kind === "word") {
    return "старый формат .doc — только во внешнем Word (сохраните как .docx для просмотра внутри)";
  }
  if (file.kind === "visio") return "только во внешнем Visio";
  return "откроется во внешней программе";
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function bytesToBlobUrl(bytes: Uint8Array, mime: string): string {
  const copy = Uint8Array.from(bytes);
  return URL.createObjectURL(new Blob([copy.buffer], { type: mime }));
}

function hasPreviewableFiles(files: CardFile[]): boolean {
  return files.some(canPreviewInApp);
}

export function CardsPage({ initialCardId = null }: Props) {
  const [query, setQuery] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [selected, setSelected] = useState<Card | null>(null);
  const [activeFile, setActiveFile] = useState<CardFile | null>(null);
  const [previewUrl, setPreviewUrl] = useState<{ mime: string; url: string } | null>(null);
  const [docxBytes, setDocxBytes] = useState<Uint8Array | null>(null);
  const [openedExternally, setOpenedExternally] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const docxHostRef = useRef<HTMLDivElement>(null);
  const previewUrlRef = useRef<string | null>(null);

  function revokePreviewUrl() {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
  }

  useEffect(() => {
    const t = window.setTimeout(() => {
      void (async () => {
        // Всего ИК в базе ~240+; 100 обрезало список при пустом поиске.
        const list = await api.listCards(query, 2000);
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
        resetPreview();
        await api.addHistory("card", full.id, full.title);
        const first = full.files.find(canPreviewInApp);
        if (first) void openFile(first);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialCardId]);

  useEffect(() => {
    const host = docxHostRef.current;
    if (!host) return;
    host.replaceChildren();
    if (!docxBytes) return;

    let cancelled = false;
    void (async () => {
      try {
        const { renderAsync } = await import("docx-preview");
        if (cancelled) return;
        await renderAsync(docxBytes, host, undefined, {
          className: "docx",
          inWrapper: true,
          ignoreWidth: true,
          ignoreHeight: true,
          breakPages: true,
          useBase64URL: true,
        });
      } catch (e) {
        if (cancelled) return;
        host.replaceChildren();
        setError(
          `Не удалось показать DOCX в окне: ${e instanceof Error ? e.message : String(e)}` +
            "\nНажмите «Открыть внешне»."
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [docxBytes]);

  useEffect(() => {
    return () => revokePreviewUrl();
  }, []);

  function resetPreview() {
    setActiveFile(null);
    revokePreviewUrl();
    setPreviewUrl(null);
    setDocxBytes(null);
    setOpenedExternally(false);
  }

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
      resetPreview();
      await api.addHistory("card", full.id, full.title);
      const first = full.files.find(canPreviewInApp);
      if (first) await openFile(first);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file: CardFile) {
    setError(null);
    setBusy(true);
    revokePreviewUrl();
    setPreviewUrl(null);
    setDocxBytes(null);
    setOpenedExternally(false);
    setActiveFile(file);
    try {
      const previewTarget =
        canPreviewInApp(file) || !selected ? file : findPdfFallback(file, selected.files) ?? file;
      if (previewTarget.kind === "jpg") {
        const b64 = await api.readFileBase64(previewTarget.path);
        const ext = fileExt(previewTarget);
        const mime =
          ext === "png"
            ? "image/png"
            : ext === "webp"
              ? "image/webp"
              : ext === "bmp"
                ? "image/bmp"
                : "image/jpeg";
        const url = bytesToBlobUrl(base64ToBytes(b64), mime);
        previewUrlRef.current = url;
        setPreviewUrl({ mime, url });
        setActiveFile(previewTarget);
        return;
      }
      if (previewTarget.kind === "pdf") {
        const b64 = await api.readFileBase64(previewTarget.path);
        const url = bytesToBlobUrl(base64ToBytes(b64), "application/pdf");
        previewUrlRef.current = url;
        setPreviewUrl({ mime: "application/pdf", url });
        setActiveFile(previewTarget);
        return;
      }
      if (previewTarget.kind === "word" && fileExt(previewTarget) === "docx") {
        const b64 = await api.readFileBase64(previewTarget.path);
        setDocxBytes(base64ToBytes(b64));
        setActiveFile(previewTarget);
        return;
      }
      // .doc / Visio и прочее — только внешне, с понятным пояснением.
      await api.openPath(file.path);
      setOpenedExternally(true);
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)) +
          "\nЕсли файл в облаке Z: — откройте папку и дождитесь скачивания, затем снова «Просмотр»."
      );
    } finally {
      setBusy(false);
    }
  }

  async function openExternally(file: CardFile) {
    setError(null);
    try {
      await api.openPath(file.path);
      setOpenedExternally(true);
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : String(e)) +
          "\nЕсли файл в облаке Z: — откройте папку и дождитесь скачивания."
      );
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
        <div className="results-meta" style={{ padding: "4px 8px", opacity: 0.7, fontSize: 12 }}>
          {query.trim() ? `Найдено: ${cards.length}` : `Всего: ${cards.length}`}
        </div>
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
            <div className="muted" style={{ marginBottom: "0.5rem" }}>
              Внутри программы: JPG, PDF и DOCX. Старые DOC и Visio — только во внешней программе.
            </div>
            {selected.files.length === 0 && (
              <div className="status-banner">
                В индексе нет файлов. Откройте папку вручную — возможно, облако ещё не скачало
                содержимое.
              </div>
            )}
            {selected.files.length > 0 && !hasPreviewableFiles(selected.files) && (
              <div className="status-banner" style={{ marginBottom: "0.75rem" }}>
                В этой карточке сейчас только старые файлы `DOC` / `Visio`. Встроенный просмотр
                работает только для `PDF`, изображений и `DOCX`, поэтому эти документы открываются
                внешними программами.
              </div>
            )}

            <div className="doc-rows">
              {selected.files.map((f) => (
                <div key={f.id} className="doc-row">
                  <div>
                    <strong>
                      {fileLabel(f)}: {f.name}
                    </strong>
                    <div className="muted" style={{ fontSize: "0.8rem" }}>
                      {previewHint(f, selected.files)}
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className={`btn ${canPreviewInApp(f) ? "primary" : ""}`}
                      disabled={busy}
                      onClick={() => void openFile(f)}
                    >
                      {canPreviewInApp(f) ? "Просмотр" : "Открыть"}
                    </button>
                    <button className="btn" onClick={() => void openExternally(f)}>
                      Внешне
                    </button>
                  </div>
                </div>
              ))}
            </div>

            {error && (
              <div className="status-banner warn" style={{ whiteSpace: "pre-wrap", marginTop: "0.75rem" }}>
                {error}
              </div>
            )}

            {openedExternally && activeFile && (
              <div className="status-banner" style={{ marginTop: "0.75rem" }}>
                {fileLabel(activeFile)} открыт во внешней программе.{" "}
                {activeFile.kind === "word" && fileExt(activeFile) !== "docx"
                  ? "Чтобы смотреть внутри Атласа — сохраните файл как .docx."
                  : null}
              </div>
            )}

            {previewUrl?.mime.startsWith("image/") && (
              <img
                src={previewUrl.url}
                alt={activeFile?.name || "preview"}
                style={{ marginTop: "1rem" }}
              />
            )}
            <div
              ref={docxHostRef}
              className={`docx-host ${docxBytes ? "" : "is-empty"}`}
              aria-label="Просмотр документа Word"
            />
          </>
        )}
      </section>
      {previewUrl?.mime === "application/pdf" && activeFile && (
        <PdfViewer
          url={previewUrl.url}
          title={`${fileLabel(activeFile)} · ${activeFile.name}`}
          onClose={() => {
            revokePreviewUrl();
            setPreviewUrl(null);
            setActiveFile(null);
          }}
          onOpenExternal={() => {
            void openExternally(activeFile);
          }}
        />
      )}
    </div>
  );
}
