/**
 * Cliente de la API (Google Apps Script Web App).
 * Todas las llamadas: POST, Content-Type text/plain (evita preflight CORS), cuerpo JSON.
 */
import { API_URL, API_CONFIGURED } from './config.js';

const TIMEOUT_MS = 15000;

/** Error de API con código: AUTH | VALIDATION | SERVER | NETWORK | TIMEOUT | CONFIG */
export class ApiError extends Error {
  constructor(message, code = 'SERVER') {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

// Callback que app.js registra para forzar re-login cuando el token vence.
let onAuthError = null;
export function setAuthErrorHandler(fn) { onAuthError = fn; }

// Token actual (lo setea app.js tras login / al restaurar sesión).
let currentToken = null;
export function setToken(token) { currentToken = token || null; }

/**
 * Llama a una acción de la API.
 * @returns {Promise<any>} `data` de la respuesta si ok:true
 * @throws {ApiError}
 */
export async function call(action, params = {}, { timeout = TIMEOUT_MS, auth = true } = {}) {
  if (!API_CONFIGURED) {
    throw new ApiError('La app no tiene configurada la URL del servidor (config.js).', 'CONFIG');
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new ApiError('Sin conexión a internet.', 'NETWORK');
  }

  const body = { action, ...params };
  if (auth) body.token = currentToken;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let res;
  try {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
      redirect: 'follow', // Apps Script responde con un 302 a googleusercontent.com
      cache: 'no-store',
    });
  } catch (err) {
    if (err.name === 'AbortError') throw new ApiError('El servidor tardó demasiado en responder.', 'TIMEOUT');
    throw new ApiError('No se pudo conectar con el servidor. Revisá la conexión.', 'NETWORK');
  } finally {
    clearTimeout(timer);
  }

  let text = '';
  try { text = await res.text(); } catch { /* cuerpo ilegible */ }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Apps Script devuelve HTML cuando hay un error de despliegue o de permisos.
    throw new ApiError(
      res.ok ? 'Respuesta inválida del servidor.' : `Error del servidor (HTTP ${res.status}).`,
      'SERVER'
    );
  }

  if (!json || json.ok !== true) {
    const code = (json && json.code) || 'SERVER';
    const msg = (json && json.error) || 'Error desconocido del servidor.';
    if (code === 'AUTH' && onAuthError) onAuthError(msg);
    throw new ApiError(msg, code);
  }
  return json.data;
}

// ---- Atajos por acción ----
export const ping = () => call('ping', {}, { auth: false, timeout: 8000 });
export const login = (usuario, pin) => call('login', { usuario, pin }, { auth: false });
export const bootstrap = () => call('bootstrap', {}, { timeout: 30000 });
export const enviarPedidos = (pedidos) => call('enviarPedidos', { pedidos }, { timeout: 30000 });
export const dashboard = () => call('dashboard', {}, { timeout: 30000 });
export const exhibidores = () => call('exhibidores', {}, { timeout: 10000 });
