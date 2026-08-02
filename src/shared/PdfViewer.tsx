import { useEffect, useState } from "react";

interface Props {
  url: string;
  title: string;
  onClose: () => void;
  onOpenExternal?: () => void;
}

export function PdfViewer({ url, title, onClose, onOpenExternal }: Props) {
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "-") {
        e.preventDefault();
        setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        setZoom(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="pdf-viewer-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <header className="pdf-viewer-toolbar">
        <strong className="pdf-viewer-title" title={title}>
          {title}
        </strong>
        <div className="pdf-viewer-actions">
          <button type="button" className="btn" onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))}>
            −
          </button>
          <span className="pdf-viewer-zoom">{Math.round(zoom * 100)}%</span>
          <button type="button" className="btn" onClick={() => setZoom((z) => Math.min(3, Math.round((z + 0.1) * 10) / 10))}>
            +
          </button>
          <button type="button" className="btn" onClick={() => setZoom(1)}>
            100%
          </button>
          {onOpenExternal && (
            <button type="button" className="btn" onClick={onOpenExternal}>
              Внешне
            </button>
          )}
          <button type="button" className="btn primary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </header>
      <div className="pdf-viewer-body">
        <iframe title={title} src={url} style={{ zoom }} />
      </div>
    </div>
  );
}
