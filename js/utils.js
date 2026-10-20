/**
 * Utilidades generales: escape de HTML, formato de moneda/fechas, búsqueda sin tildes.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escapa cualquier valor para insertarlo de forma segura en HTML (texto o atributos). */
export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"'`]/g, (ch) => HTML_ESCAPES[ch]);
}

const GS_FORMAT = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });
const NUM_FORMAT = new Intl.NumberFormat('es-PY', { maximumFractionDigits: 0 });

/** Formatea guaraníes: 1250000 → "Gs 1.250.000". */
export function formatGs(value) {
  const n = Number(value);
  return 'Gs ' + GS_FORMAT.format(Number.isFinite(n) ? Math.round(n) : 0);
}

/** Formatea un número entero con separador de miles. */
export function formatNum(value) {
  const n = Number(value);
  return NUM_FORMAT.format(Number.isFinite(n) ? n : 0);
}

const TZ = 'America/Asuncion';
const DATE_TIME_FMT = new Intl.DateTimeFormat('es-PY', {
  timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
});
const TIME_FMT = new Intl.DateTimeFormat('es-PY', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

/** "03/11 14:25" en hora de Asunción. Acepta ISO o Date. */
export function formatDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return String(value ?? '');
  return DATE_TIME_FMT.format(d);
}

export function formatTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return TIME_FMT.format(d);
}

/** "hace 3 min", "hace instantes", "hace 2 h". */
export function timeAgo(value) {
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(t)) return '—';
  const sec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (sec < 45) return 'hace instantes';
  const min = Math.round(sec / 60);
  if (min < 60) return `hace ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h} h ${min % 60} min`;
  return `el ${formatDateTime(t)}`;
}

/** Normaliza texto para búsqueda: minúsculas, sin tildes, espacios simples. */
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Coincide si TODAS las palabras de la consulta están en el texto indexado
 * (ej. "dog chow 15" encuentra "DOG CHOW ADULTO 15KG").
 */
export function matchesQuery(indexText, normalizedQuery) {
  if (!normalizedQuery) return true;
  const words = normalizedQuery.split(' ');
  for (const w of words) if (!indexText.includes(w)) return false;
  return true;
}

/** Retrasa la ejecución hasta que pasen `wait` ms sin nuevas llamadas. */
export function debounce(fn, wait = 200) {
  let timer = null;
  const debounced = (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}

/** Convierte cualquier entrada en entero dentro de [min, max]. */
export function clampInt(value, min, max) {
  const n = parseInt(String(value).replace(/\D/g, ''), 10);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** Rellena con ceros a la izquierda: pad(7, 4) → "0007". */
export function pad(n, size) {
  return String(n).padStart(size, '0');
}

/** Pequeña espera (para backoff). */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
