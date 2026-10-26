/**
 * Configuración de la app.
 * ÚNICO valor a editar al desplegar: API_URL (URL /exec del Web App de Apps Script).
 */

// Versión de la app. Si la cambiás, cambiá también SHELL_VERSION en sw.js.
export const APP_VERSION = '1.5.3';

// URL del Web App de Google Apps Script (termina en /exec).
const DEFAULT_API_URL = 'https://script.google.com/macros/s/AKfycbyJlYElj1ikeTYB0pym64Wv9Wqr8FGQu_xpOZpzEixsizTS4uxFv60RiXHz0bdZoj5smw/exec';

// Clave de localStorage para el override de pruebas (?api=http://localhost:8080/api).
const API_OVERRIDE_KEY = 'expovet.apiOverride';

/**
 * Permite probar contra otro servidor (ej. el mock local) agregando ?api=URL.
 * El valor queda guardado en localStorage. Para volver al default: ?api=default
 */
const IS_LOCAL_DEV = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

function resolveApiUrl() {
  try {
    const qs = new URLSearchParams(location.search);
    const fromQuery = qs.get('api');
    if (fromQuery === 'default' || fromQuery === '') {
      localStorage.removeItem(API_OVERRIDE_KEY);
    } else if (fromQuery && /^https?:\/\//i.test(fromQuery) && IS_LOCAL_DEV) {
      localStorage.setItem(API_OVERRIDE_KEY, fromQuery);
    }
    // Seguridad: el override solo vale en desarrollo local. En producción un link
    // con ?api=https://otro-sitio podría desviar los PIN y pedidos a un tercero.
    return (IS_LOCAL_DEV && localStorage.getItem(API_OVERRIDE_KEY)) || DEFAULT_API_URL;
  } catch {
    return DEFAULT_API_URL;
  }
}

export const API_URL = resolveApiUrl();

/** true si todavía no se pegó la URL real del Apps Script. */
export const API_CONFIGURED = /^https?:\/\//i.test(API_URL);
