import DOMPurify from "dompurify";

/**
 * Описания в KML/KMZ приходят как вёрстка Google Earth: <br>, таблицы,
 * ссылки на внешние картинки и инлайновые стили. Оставляем структуру текста,
 * но убираем всё, что не отображается в offline-приложении или мешает чтению.
 */
const ALLOWED_TAGS = [
  "p",
  "br",
  "hr",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "small",
  "sub",
  "sup",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "caption",
  "div",
  "span",
  "a",
  "h1",
  "h2",
  "h3",
  "h4",
  "pre",
  "code",
];

const ALLOWED_ATTR = ["href", "title", "colspan", "rowspan"];

export function sanitizeDescription(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  });
}

/** Есть ли в описании хоть что-то, кроме разметки и пробелов. */
export function hasReadableText(html: string): boolean {
  const text = html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 0;
}
