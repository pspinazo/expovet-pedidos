/**
 * App principal: sesión, router por hash, pantallas y estado global.
 *
 * Rutas:
 *   #/login      Ingreso (usuario + PIN)
 *   #/home       Inicio vendedor (supervisor → dashboard)
 *   #/nuevo      Nuevo pedido (pasos 1 Cliente → 2 Productos → 3 Confirmar)
 *   #/pedidos    Mis pedidos (cola local)
 *   #/resumen    Mi resumen (vendedor)
 *   #/dashboard  Dashboard (supervisor)
 */
import { APP_VERSION, API_CONFIGURED } from './config.js';
import * as api from './api.js';
import * as db from './db.js';
import { processQueue, retryPedido, syncEvents } from './sync.js';
import { renderDashboard, stopDashboard } from './dashboard.js';
import {
  escapeHtml, formatGs, formatNum, formatDateTime, timeAgo,
  normalizeText, matchesQuery, debounce, clampInt, pad,
} from './utils.js';

// ---------------- Constantes ----------------
const SYNC_INTERVAL_MS = 60 * 1000;   // cola de envío
const PING_INTERVAL_MS = 30 * 1000;   // verificación de conexión real
const MAX_RESULTS = 50;               // tope de resultados renderizados en búsquedas
const MAX_QTY = 100000;               // igual que la validación del servidor
const SEARCH_DEBOUNCE_MS = 180;
const DRAFT_KEY = 'draft';
const CATALOG_MAX_AGE_MS = 10 * 60 * 1000; // al abrir la app, refrescar catálogo si es más viejo que esto

// ---------------- Estado global ----------------
const state = {
  session: null,          // { token, user, savedAt }
  authExpired: false,     // token vencido: se sigue trabajando offline
  online: navigator.onLine,
  serverReachable: null,  // resultado del último ping (null = desconocido)
  productos: [],          // con _idx (texto normalizado para búsqueda)
  clientes: [],
  productosBySku: new Map(),
  draft: null,            // borrador del pedido en curso
  submitting: false,
  catalogAt: null,
  catalogRefreshing: false, // evita dos actualizaciones de catálogo en paralelo
};

const $ = (sel, root = document) => root.querySelector(sel);
const main = $('#main');

const isVendor = () => !!state.session && normalizeText(state.session.user.rol) === 'vendedor';

// =====================================================================
// Utilidades de UI: toasts, diálogos, banner
// =====================================================================

/** Muestra un aviso breve. type: info | ok | warn | error */
function toast(message, type = 'info', ms = 3500) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 300);
  }, ms);
}

/**
 * Diálogo modal accesible (usa <dialog>). Devuelve el valor del botón pulsado.
 * @param {{title:string, html?:string, text?:string, buttons:Array<{label:string,value:any,kind?:string}>}} opts
 */
function modal({ title, html = '', text = '', buttons }) {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dialog';
    dlg.setAttribute('aria-labelledby', 'dlg-title');
    dlg.innerHTML = `
      <h2 id="dlg-title" class="dialog__title">${escapeHtml(title)}</h2>
      <div class="dialog__body">${text ? `<p>${escapeHtml(text)}</p>` : ''}${html}</div>
      <div class="dialog__actions">
        ${buttons.map((b, i) => `<button type="button" class="btn btn--${b.kind || 'ghost'}" data-i="${i}">${escapeHtml(b.label)}</button>`).join('')}
      </div>`;
    $('#modal-root').appendChild(dlg);
    const finish = (value) => { dlg.close(); dlg.remove(); resolve(value); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(undefined); });
    dlg.querySelector('.dialog__actions').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-i]');
      if (btn) finish(buttons[Number(btn.dataset.i)].value);
    });
    dlg.showModal();
    const primary = dlg.querySelector('.btn--primary, .btn--danger') || dlg.querySelector('button');
    primary && primary.focus();
  });
}

const confirmDialog = (title, text, okLabel = 'Sí', kind = 'primary') =>
  modal({ title, text, buttons: [{ label: 'No, volver', value: false }, { label: okLabel, value: true, kind }] });

/** Banner superior persistente (sesión vencida, catálogo faltante, etc.). */
function updateBanner() {
  const el = $('#banner');
  const msgs = [];
  if (!API_CONFIGURED) {
    msgs.push('<span>Falta configurar la URL del servidor en <code>js/config.js</code>.</span>');
  }
  if (state.session && state.authExpired) {
    msgs.push(`<span><strong>Tu sesión venció.</strong> Podés seguir cargando pedidos sin problema; para enviarlos volvé a ingresar tu PIN.</span>
      <button type="button" class="btn btn--sm btn--light" data-action="relogin">Ingresar PIN</button>`);
  }
  if (state.session && isVendor() && state.productos.length === 0) {
    msgs.push(`<span><strong>No hay catálogo descargado.</strong> Conectate a internet y actualizalo para poder cargar pedidos.</span>
      <button type="button" class="btn btn--sm btn--light" data-action="refresh-catalog">Descargar</button>`);
  }
  el.hidden = msgs.length === 0;
  el.innerHTML = msgs.map((m) => `<div class="banner__row">${m}</div>`).join('');
}

// =====================================================================
// Conexión y contador de pendientes
// =====================================================================

function isOnline() {
  return state.online && state.serverReachable !== false;
}

function updateConnBadge() {
  const el = $('#conn-badge');
  const on = isOnline();
  el.classList.toggle('is-online', on);
  el.classList.toggle('is-offline', !on);
  el.querySelector('.conn__label').textContent = on ? 'En línea' : 'Sin señal';
}

async function checkConnection() {
  state.online = navigator.onLine;
  if (!state.online || !API_CONFIGURED) {
    state.serverReachable = state.online ? null : false;
  } else {
    try {
      await api.ping();
      state.serverReachable = true;
    } catch (err) {
      state.serverReachable = !(err.code === 'NETWORK' || err.code === 'TIMEOUT');
    }
  }
  updateConnBadge();
}

async function updatePendingBadge() {
  if (!state.session || !isVendor()) { $('#pending-badge').hidden = true; return; }
  const [pend, err] = await Promise.all([
    db.countPedidosByEstado(db.ESTADOS.PENDIENTE),
    db.countPedidosByEstado(db.ESTADOS.ERROR),
  ]);
  const total = pend + err;
  const badge = $('#pending-badge');
  badge.hidden = total === 0;
  badge.classList.toggle('has-error', err > 0);
  $('#pending-count').textContent = String(total);
  $('#pending-label').textContent = err > 0
    ? `sin enviar (${err} con error)`
    : (total === 1 ? 'pendiente de enviar' : 'pendientes de enviar');
  badge.setAttribute('aria-label', `${total} pedidos sin enviar. Ver mis pedidos.`);
}

/** Dispara la cola y refresca UI. */
async function runSync(manual = false, notify = manual) {
  if (!state.session || !isVendor()) return null;
  if (state.authExpired) {
    if (notify) toast('Tu sesión venció: ingresá tu PIN para enviar.', 'warn');
    return null;
  }
  const res = await processQueue({ manual });
  if (notify && res && !res._notified) {
    res._notified = true;
    if (res.code === 'NETWORK') toast('Sin conexión. Los pedidos quedan guardados y se enviarán solos.', 'warn');
    else if (res.fallo) toast(`No se pudo enviar: ${res.fallo}`, 'error');
    else if (res.enviados || res.errores) {
      toast(`Enviados: ${res.enviados}${res.errores ? ` · Con error: ${res.errores}` : ''}`, res.errores ? 'warn' : 'ok');
    } else toast('No hay pedidos pendientes.', 'info');
  } else if (res && !res.skipped && res.enviados && !res._notified) {
    res._notified = true; // la misma promesa puede llegar a varios llamadores: un solo aviso
    toast(`${res.enviados} pedido${res.enviados > 1 ? 's' : ''} enviado${res.enviados > 1 ? 's' : ''} ✓`, 'ok');
  }
  return res;
}

// Cada cambio en la cola actualiza el contador y, si corresponde, la pantalla de pedidos.
syncEvents.addEventListener('change', (e) => {
  updatePendingBadge();
  if (e.detail && e.detail.code === 'NETWORK') { state.serverReachable = false; updateConnBadge(); }
  if (location.hash.startsWith('#/pedidos') && !e.detail.sending) renderPedidos();
});

// =====================================================================
// Sesión
// =====================================================================

/** Lee el `exp` del token (payload base64url antes del punto). Devuelve ms o null. */
function tokenExpMs(token) {
  try {
    const part = String(token).split('.')[0];
    const json = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4)));
    const exp = Number(json.exp);
    if (!Number.isFinite(exp)) return null;
    return exp < 1e12 ? exp * 1000 : exp; // admite segundos o milisegundos
  } catch {
    return null;
  }
}

function applySessionToHeader() {
  const u = state.session.user;
  $('#topbar').hidden = false;
  $('#user-name').textContent = u.nombre || u.id;
  $('#user-role').textContent = `${u.rol || ''}${u.canal ? ' · ' + u.canal : ''}`;
  document.querySelectorAll('[data-vendor-only]').forEach((el) => { el.hidden = !isVendor(); });
  $('#menu-meta').textContent = `v${APP_VERSION}${state.catalogAt ? ' · Catálogo ' + timeAgo(state.catalogAt) : ''}`;
}

/** Carga productos y clientes desde IndexedDB a memoria con índice de búsqueda. */
async function loadMasterData() {
  const [productos, clientes, catalogAt] = await Promise.all([
    db.getAll(db.STORES.PRODUCTOS), db.getAll(db.STORES.CLIENTES), db.getMeta('catalogAt'),
  ]);
  state.productos = productos
    .map((p) => ({ ...p, _idx: normalizeText(`${p.sku} ${p.codBarra} ${p.marca} ${p.descripcion} ${comboSearchText(p)}`) }))
    .sort((a, b) => String(a.descripcion).localeCompare(String(b.descripcion), 'es'));
  state.productosBySku = new Map(state.productos.map((p) => [String(p.sku), p]));
  state.clientes = clientes
    .map((c) => ({ ...c, _idx: normalizeText(`${c.id} ${c.razonSocial} ${c.nombreFantasia}`) }))
    .sort((a, b) => String(a.nombreFantasia || a.razonSocial).localeCompare(String(b.nombreFantasia || b.razonSocial), 'es'));
  state.catalogAt = catalogAt;
}

/** Texto extra de búsqueda de un combo: la palabra "combo" + SKU y descripción de sus componentes. */
function comboSearchText(p) {
  if (!p.esCombo) return '';
  return `combo ${(p.componentes || []).map((c) => `${c.sku} ${c.descripcion}`).join(' ')}`;
}

/** Contenido de un combo en una línea: "2× Alimento X · 1× Antipulgas Y". */
function comboContents(p) {
  return (p.componentes || []).map((c) => `${formatNum(c.cantidad)}× ${c.descripcion}`).join(' · ');
}

/** Etiqueta "COMBO" (vacía si no es combo). */
function comboBadge(p) {
  return p && p.esCombo ? '<span class="badge-combo">COMBO</span> ' : '';
}

/** Normaliza un producto de la API para IndexedDB (conserva campos nuevos como esCombo/componentes). */
function toStoredProducto(p) {
  return {
    ...p,
    sku: String(p.sku), codBarra: String(p.codBarra ?? ''), marca: p.marca ?? '',
    descripcion: p.descripcion ?? '', precio: Number(p.precio) || 0,
    esCombo: !!p.esCombo,
    componentes: Array.isArray(p.componentes)
      ? p.componentes.map((c) => ({
        sku: String(c.sku), descripcion: c.descripcion ?? '', cantidad: Number(c.cantidad) || 0, precio: Number(c.precio) || 0,
      }))
      : [],
  };
}

/**
 * Descarga catálogo + clientes del servidor y los guarda en IndexedDB.
 * silent: sin aviso de éxito (y sin aviso si no hay red).
 * background: además sin ningún aviso de error (actualización automática).
 */
async function refreshCatalog({ silent = false, background = false } = {}) {
  if (state.catalogRefreshing) {
    if (!silent) toast('El catálogo ya se está actualizando…', 'info', 2000);
    return false;
  }
  state.catalogRefreshing = true;
  try {
    const data = await api.bootstrap();
    await db.replaceAll(db.STORES.PRODUCTOS, (data.productos || []).map(toStoredProducto));
    await db.replaceAll(db.STORES.CLIENTES, (data.clientes || []).map((c) => ({ ...c, id: String(c.id) })));
    await db.setMeta('serverCorrelativo', Number(data.ultimoCorrelativo) || 0);
    await db.setMeta('catalogVersion', data.version ?? null);
    await db.setMeta('catalogAt', new Date().toISOString());
    await loadMasterData();
    applySessionToHeader();
    updateBanner();
    if (!silent) toast(`Catálogo actualizado: ${formatNum(state.productos.length)} productos, ${formatNum(state.clientes.length)} clientes`, 'ok');
    return true;
  } catch (err) {
    if (background) console.warn('Actualización automática del catálogo falló:', err.message);
    else if (!silent || err.code !== 'NETWORK') toast(`No se pudo actualizar el catálogo: ${err.message}`, 'error', 5000);
    return false;
  } finally {
    state.catalogRefreshing = false;
  }
}

/**
 * Al abrir la app (vendedor con internet): si el catálogo tiene más de 10 min,
 * se actualiza en segundo plano sin bloquear ni avisar. Si el vendedor está
 * cargando un pedido, solo se redibujan las listas (no se pierde lo escrito).
 */
async function autoRefreshCatalog() {
  if (!state.session || !isVendor() || state.authExpired || !API_CONFIGURED || !navigator.onLine) return;
  const at = state.catalogAt ? new Date(state.catalogAt).getTime() : 0;
  if (Date.now() - at < CATALOG_MAX_AGE_MS) return;
  const prev = state.productosBySku;
  const ok = await refreshCatalog({ silent: true, background: true });
  if (!ok) return;
  // ¿Algún ítem del carrito cambió de precio o dejó de ofrecerse? (se compara catálogo viejo vs nuevo
  // sobre los ítems actuales, así lo que el vendedor agregó mientras tanto no cuenta como cambio)
  const cartChanged = !!state.draft && Object.keys(state.draft.items).some((sku) => {
    const a = prev.get(sku);
    const b = state.productosBySku.get(sku);
    return !!a !== !!b || (a && b && a.precio !== b.precio);
  });
  redrawOrderLists(cartChanged);
  // El carrito en curso cambió (precio distinto o producto/combo que ya no se ofrece): avisar.
  if (cartChanged && location.hash.startsWith('#/nuevo')) {
    toast('Se actualizó el catálogo y cambiaron precios o productos de tu carrito. Revisalo antes de confirmar.', 'warn', 6000);
  }
}

/** Redibuja las listas visibles de "Nuevo pedido" con el catálogo nuevo. */
function redrawOrderLists(cartChanged = false) {
  if (!location.hash.startsWith('#/nuevo') || !state.draft) return;
  // Paso 3: el resumen muestra el total que se va a guardar; si cambió, redibujar
  // (las observaciones ya están en state.draft). No interrumpir un guardado en curso.
  if (state.draft.step === 3) {
    if (cartChanged && !state.submitting && $('#confirm-btn')) renderNuevo();
    return;
  }
  // Una cantidad que se está escribiendo (aún sin "change") no se pierde al redibujar.
  const act = document.activeElement;
  if (act && act.matches && act.matches('input[data-qty-input]')) setQty(act.dataset.sku, clampInt(act.value, 0, MAX_QTY));
  const cliQ = $('#cli-q');
  if (cliQ) drawClientes(normalizeText(cliQ.value));
  const prodQ = $('#prod-q');
  if (prodQ) { drawProductos(normalizeText(prodQ.value)); drawCart(); }
}

async function saveSession(token, user) {
  state.session = { token, user, savedAt: new Date().toISOString() };
  state.authExpired = false;
  api.setToken(token);
  await db.setMeta('session', state.session);
}

/** Pide al navegador no borrar los datos locales (pedidos) por falta de espacio. */
async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* no soportado */ }
}

async function logout() {
  const [pend, err] = await Promise.all([
    db.countPedidosByEstado(db.ESTADOS.PENDIENTE),
    db.countPedidosByEstado(db.ESTADOS.ERROR),
  ]);
  if (pend + err > 0) {
    await modal({
      title: 'No podés cerrar sesión todavía',
      text: `Hay ${pend + err} pedido(s) sin enviar en esta tablet. Si cerrás sesión se perderían. Enviálos primero (o revisá los que tienen error en "Mis pedidos").`,
      buttons: [{ label: 'Entendido', value: true, kind: 'primary' }],
    });
    location.hash = '#/pedidos';
    return;
  }
  const ok = await confirmDialog('Cerrar sesión', 'Se borrarán de esta tablet el catálogo, los clientes y el historial de pedidos enviados. ¿Continuar?', 'Cerrar sesión', 'danger');
  if (!ok) return;
  await db.clearAll();
  state.session = null;
  state.productos = []; state.clientes = []; state.productosBySku = new Map(); state.draft = null;
  api.setToken(null);
  $('#toasts').innerHTML = '';
  $('#topbar').hidden = true;
  updateBanner();
  location.hash = '#/login';
  render();
}

/** Re-login con PIN cuando el token venció (sin borrar nada local). */
async function reloginFlow() {
  if (!state.session) return;
  const u = state.session.user;
  const dlg = document.createElement('dialog');
  dlg.className = 'dialog';
  dlg.innerHTML = `
    <form method="dialog" class="form" id="relogin-form" novalidate>
      <h2 class="dialog__title">Volver a ingresar</h2>
      <p>Usuario: <strong>${escapeHtml(u.nombre || u.id)}</strong> (${escapeHtml(u.id)})</p>
      <label class="field">
        <span class="field__label">PIN</span>
        <input class="input input--pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" required>
      </label>
      <p class="form__error" role="alert" hidden></p>
      <div class="dialog__actions">
        <button type="button" class="btn btn--ghost" data-cancel>Cancelar</button>
        <button type="submit" class="btn btn--primary">Ingresar</button>
      </div>
    </form>`;
  $('#modal-root').appendChild(dlg);
  const form = dlg.querySelector('form');
  const errEl = form.querySelector('.form__error');
  const close = () => { dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', close);
  dlg.addEventListener('cancel', close);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const pin = form.pin.value.trim();
    const btn = form.querySelector('[type=submit]');
    if (!pin) { errEl.hidden = false; errEl.textContent = 'Ingresá tu PIN.'; return; }
    btn.disabled = true; btn.classList.add('is-loading');
    try {
      const data = await api.login(u.id, pin);
      if (String(data.user.id) !== String(u.id)) throw new api.ApiError('El PIN corresponde a otro usuario.', 'VALIDATION');
      await saveSession(data.token, data.user);
      applySessionToHeader();
      updateBanner();
      close();
      toast('Sesión renovada', 'ok');
      runSync(true);
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.code === 'NETWORK' ? 'Necesitás internet para volver a ingresar.' : err.message;
    } finally {
      btn.disabled = false; btn.classList.remove('is-loading');
    }
  });
  dlg.showModal();
  form.pin.focus();
}

// El api avisa cuando el servidor responde AUTH (token vencido o inválido).
api.setAuthErrorHandler(() => {
  if (!state.session) return;
  state.authExpired = true;
  updateBanner();
});

// =====================================================================
// Router
// =====================================================================

const ROUTES = {
  '#/login': renderLogin,
  '#/home': renderHome,
  '#/nuevo': renderNuevo,
  '#/pedidos': renderPedidos,
  '#/resumen': () => renderDash(true),
  '#/dashboard': () => renderDash(false),
};

function render() {
  stopDashboard();
  closeMenu();
  let route = location.hash.split('?')[0] || '#/home';
  if (!state.session) route = '#/login';
  else if (route === '#/login') route = '#/home';
  // Supervisores no toman pedidos: su inicio es el dashboard.
  if (state.session && !isVendor() && ['#/home', '#/nuevo', '#/pedidos', '#/resumen'].includes(route)) route = '#/dashboard';
  if (state.session && isVendor() && route === '#/dashboard') route = '#/resumen';
  if (!ROUTES[route]) route = '#/home';
  if (location.hash !== route) history.replaceState(null, '', route);
  document.body.dataset.route = route.slice(2);
  ROUTES[route]();
  main.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);

// Navegación declarativa: cualquier elemento con data-nav="#/ruta"
document.addEventListener('click', (e) => {
  const nav = e.target.closest('[data-nav]');
  if (nav) {
    e.preventDefault();
    const to = nav.dataset.nav;
    if (location.hash === to) render(); else location.hash = to;
    return;
  }
  const act = e.target.closest('[data-action]');
  if (!act) return;
  const action = act.dataset.action;
  if (action === 'logout') { closeMenu(); logout(); }
  if (action === 'refresh-catalog') { closeMenu(); refreshCatalogWithUi(); }
  if (action === 'sync') { closeMenu(); runSync(true); }
  if (action === 'relogin') reloginFlow();
});

async function refreshCatalogWithUi() {
  if (!isVendor()) return;
  toast('Actualizando catálogo…', 'info', 2000);
  await refreshCatalog();
  if (location.hash.startsWith('#/nuevo')) renderNuevo();
}

// ---------- Menú ----------
function closeMenu() {
  $('#menu').hidden = true;
  $('#menu-btn').setAttribute('aria-expanded', 'false');
}
$('#menu-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = $('#menu').hidden;
  $('#menu').hidden = !open;
  $('#menu-btn').setAttribute('aria-expanded', String(open));
  if (open) $('#menu button:not([hidden])').focus();
});
document.addEventListener('click', (e) => {
  if (!$('#menu').hidden && !e.target.closest('#menu')) closeMenu();
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// =====================================================================
// Pantalla: Login
// =====================================================================

function renderLogin() {
  $('#topbar').hidden = true;
  main.innerHTML = `
    <section class="login" aria-labelledby="login-title">
      <div class="login__card">
        <div class="login__brand">
          <span class="brand-mark brand-mark--lg" aria-hidden="true">E</span>
          <div>
            <h1 id="login-title">Pedidos Expovet</h1>
            <p>Agrofield · 3 y 4 de noviembre</p>
          </div>
        </div>
        <form class="form" id="login-form" novalidate>
          <label class="field">
            <span class="field__label">Usuario</span>
            <input class="input" name="usuario" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Código o nombre de usuario" required>
          </label>
          <label class="field">
            <span class="field__label">PIN</span>
            <span class="input-group">
              <input class="input input--pin" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="current-password" placeholder="••••" required>
              <button class="btn btn--ghost input-group__btn" type="button" id="toggle-pin" aria-pressed="false" aria-label="Mostrar PIN">Ver</button>
            </span>
          </label>
          <p class="form__error" id="login-error" role="alert" hidden></p>
          <button class="btn btn--primary btn--lg btn--block" type="submit" id="login-btn">Ingresar</button>
          <p class="form__hint">La primera vez necesitás internet. Después la app funciona sin señal.</p>
        </form>
      </div>
      <p class="login__version">v${escapeHtml(APP_VERSION)}</p>
    </section>`;

  const form = $('#login-form');
  const pinInput = form.pin;
  $('#toggle-pin').addEventListener('click', (e) => {
    const show = pinInput.type === 'password';
    pinInput.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? 'Ocultar' : 'Ver';
    e.currentTarget.setAttribute('aria-pressed', String(show));
    e.currentTarget.setAttribute('aria-label', show ? 'Ocultar PIN' : 'Mostrar PIN');
  });
  form.usuario.focus();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('#login-error');
    const btn = $('#login-btn');
    const usuario = form.usuario.value.trim();
    const pin = pinInput.value.trim();
    errEl.hidden = true;
    if (!usuario || !pin) {
      errEl.hidden = false;
      errEl.textContent = 'Completá usuario y PIN.';
      (!usuario ? form.usuario : pinInput).focus();
      return;
    }
    if (btn.disabled) return;
    btn.disabled = true; btn.classList.add('is-loading'); btn.textContent = 'Ingresando…';
    try {
      const data = await api.login(usuario, pin);
      await saveSession(data.token, data.user);
      requestPersistence();
      if (isVendor()) {
        btn.textContent = 'Descargando catálogo…';
        await refreshCatalog({ silent: true });
      }
      applySessionToHeader();
      updateBanner();
      startBackgroundTasks();
      location.hash = '#/home';
      render();
      toast(`¡Hola, ${data.user.nombre || data.user.id}!`, 'ok');
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.code === 'NETWORK'
        ? 'Sin conexión. La primera vez necesitás internet para ingresar.'
        : err.message;
      btn.disabled = false; btn.classList.remove('is-loading'); btn.textContent = 'Ingresar';
    }
  });
}

// =====================================================================
// Pantalla: Inicio vendedor
// =====================================================================

async function renderHome() {
  const draft = await loadDraft();
  const hasDraft = draft && (draft.cliente || Object.keys(draft.items).length);
  main.innerHTML = `
    <section class="screen home" aria-labelledby="home-title">
      <h1 id="home-title" class="sr-only">Inicio</h1>
      <div class="home__grid">
        <button class="tile tile--primary" type="button" data-nav="#/nuevo">
          <svg viewBox="0 0 24 24" width="48" height="48" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>
          <span class="tile__title">${hasDraft ? 'Continuar pedido' : 'Nuevo pedido'}</span>
          <span class="tile__sub">${hasDraft ? escapeHtml(draft.cliente ? (draft.cliente.nombreFantasia || draft.cliente.razonSocial) : 'Borrador guardado') : 'Elegir cliente y productos'}</span>
        </button>
        <button class="tile" type="button" data-nav="#/pedidos">
          <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          <span class="tile__title">Mis pedidos</span>
          <span class="tile__sub" id="home-pedidos-sub">&nbsp;</span>
        </button>
        <button class="tile" type="button" data-nav="#/resumen">
          <svg viewBox="0 0 24 24" width="44" height="44" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
          <span class="tile__title">Mi resumen</span>
          <span class="tile__sub">Mis ventas del evento</span>
        </button>
      </div>
    </section>`;
  const all = await db.getAll(db.STORES.PEDIDOS);
  const pend = all.filter((p) => p.estado !== db.ESTADOS.ENVIADO).length;
  const sub = $('#home-pedidos-sub');
  if (sub) sub.textContent = `${all.length} en esta tablet${pend ? ` · ${pend} sin enviar` : ''}`;
}

// =====================================================================
// Pantalla: Nuevo pedido
// =====================================================================

function emptyDraft() {
  return { uid: state.session.user.id, step: 1, cliente: null, items: {}, observaciones: '', updatedAt: null };
}

async function loadDraft() {
  if (state.draft && state.draft.uid === state.session.user.id) return state.draft;
  const d = await db.getMeta(DRAFT_KEY);
  state.draft = d && d.uid === state.session.user.id ? d : emptyDraft();
  if (!state.draft.items) state.draft.items = {};
  return state.draft;
}

// Guardado del borrador (con debounce para no escribir en cada tecla).
const persistDraft = debounce(() => {
  if (!state.draft) return;
  state.draft.updatedAt = new Date().toISOString();
  db.setMeta(DRAFT_KEY, state.draft).catch((e) => console.error('No se pudo guardar el borrador', e));
}, 250);

function draftDirty(d) {
  return !!(d && (d.cliente || Object.keys(d.items).length || d.observaciones));
}

/** Líneas del carrito resueltas contra el catálogo actual. */
function cartLines() {
  const lines = [];
  for (const [sku, qty] of Object.entries(state.draft.items)) {
    const p = state.productosBySku.get(sku);
    if (!p || !(qty > 0)) continue;
    lines.push({
      sku, descripcion: p.descripcion, marca: p.marca, codBarra: p.codBarra, precio: p.precio, cantidad: qty, subtotal: p.precio * qty,
      esCombo: !!p.esCombo, contenido: p.esCombo ? comboContents(p) : '',
    });
  }
  return lines;
}

function cartTotals() {
  const lines = cartLines();
  return { lines, items: lines.length, unidades: lines.reduce((a, l) => a + l.cantidad, 0), total: lines.reduce((a, l) => a + l.subtotal, 0) };
}

async function renderNuevo() {
  if (!isVendor()) { location.hash = '#/dashboard'; return; }
  await loadDraft();
  if (state.productos.length === 0 || state.clientes.length === 0) {
    main.innerHTML = `<section class="screen"><div class="empty">
      <h1>No hay catálogo en esta tablet</h1>
      <p>Para cargar pedidos primero hay que descargar productos y clientes (necesita internet una vez).</p>
      <button class="btn btn--primary btn--lg" type="button" data-action="refresh-catalog">Descargar catálogo</button>
      <button class="btn btn--ghost btn--lg" type="button" data-nav="#/home">Volver al inicio</button>
    </div></section>`;
    return;
  }
  const d = state.draft;
  if (d.step >= 2 && !d.cliente) d.step = 1;
  if (d.step === 3 && cartLines().length === 0) d.step = 2;

  main.innerHTML = `
    <section class="screen order" aria-labelledby="order-title">
      <div class="order__head">
        <h1 id="order-title" class="order__title">Nuevo pedido</h1>
        <ol class="stepper" aria-label="Pasos del pedido">
          ${['Cliente', 'Productos', 'Confirmar'].map((s, i) => `
            <li class="stepper__item ${d.step === i + 1 ? 'is-current' : ''} ${d.step > i + 1 ? 'is-done' : ''}" ${d.step === i + 1 ? 'aria-current="step"' : ''}>
              <span class="stepper__num">${d.step > i + 1 ? '✓' : i + 1}</span><span class="stepper__label">${s}</span>
            </li>`).join('')}
        </ol>
        <button class="btn btn--ghost btn--danger-text" type="button" id="cancel-order">Cancelar</button>
      </div>
      <div id="step-body"></div>
    </section>`;

  $('#cancel-order').addEventListener('click', cancelOrder);
  if (d.step === 1) renderStepCliente();
  else if (d.step === 2) renderStepProductos();
  else renderStepConfirmar();
}

function goStep(n) {
  state.draft.step = n;
  persistDraft();
  renderNuevo();
}

async function cancelOrder() {
  if (draftDirty(state.draft)) {
    const ok = await confirmDialog('¿Cancelar el pedido?', 'Se descartará el cliente elegido y los productos cargados.', 'Sí, descartar', 'danger');
    if (!ok) return;
  }
  state.draft = emptyDraft();
  persistDraft.cancel();
  await db.delMeta(DRAFT_KEY);
  location.hash = '#/home';
}

// ---------- Paso 1: Cliente ----------
function renderStepCliente() {
  const body = $('#step-body');
  body.innerHTML = `
    <div class="search">
      <label class="field">
        <span class="field__label">Buscar cliente de tu cartera</span>
        <input class="input input--search" id="cli-q" type="search" placeholder="Código, razón social o nombre de fantasía" autocomplete="off" spellcheck="false" enterkeyhint="search">
      </label>
      <p class="search__meta" id="cli-meta" aria-live="polite"></p>
    </div>
    <ul class="list list--clients" id="cli-list"></ul>`;
  const input = $('#cli-q');
  const draw = () => drawClientes(normalizeText(input.value));
  input.addEventListener('input', debounce(draw, SEARCH_DEBOUNCE_MS));
  $('#cli-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cli]');
    if (!btn) return;
    const c = state.clientes.find((x) => x.id === btn.dataset.cli);
    if (!c) return;
    state.draft.cliente = { id: c.id, razonSocial: c.razonSocial, nombreFantasia: c.nombreFantasia, canal: c.canal };
    goStep(2);
  });
  draw();
  input.focus();
}

function drawClientes(q) {
  const matches = [];
  let total = 0;
  for (const c of state.clientes) {
    if (matchesQuery(c._idx, q)) {
      total++;
      if (matches.length < MAX_RESULTS) matches.push(c);
    }
  }
  const sel = state.draft.cliente && state.draft.cliente.id;
  $('#cli-meta').textContent = total === 0
    ? ''
    : total > MAX_RESULTS
      ? `Mostrando ${MAX_RESULTS} de ${formatNum(total)} clientes. Escribí más para afinar la búsqueda.`
      : `${formatNum(total)} cliente${total === 1 ? '' : 's'}`;
  $('#cli-list').innerHTML = matches.length
    ? matches.map((c) => `
      <li>
        <button type="button" class="client-card ${sel === c.id ? 'is-selected' : ''}" data-cli="${escapeHtml(c.id)}">
          <span class="client-card__name">${escapeHtml(c.nombreFantasia || c.razonSocial)}</span>
          <span class="client-card__meta">${escapeHtml(c.razonSocial)} · <span class="mono">${escapeHtml(c.id)}</span></span>
          <span class="client-card__go" aria-hidden="true">›</span>
        </button>
      </li>`).join('')
    : `<li class="empty empty--sm">No se encontraron clientes con “${escapeHtml(q)}”. Revisá lo escrito o buscá por código.</li>`;
}

// ---------- Paso 2: Productos ----------
function renderStepProductos() {
  const c = state.draft.cliente;
  const body = $('#step-body');
  body.innerHTML = `
    <div class="selected-client">
      <div>
        <span class="selected-client__label">Cliente</span>
        <strong class="selected-client__name">${escapeHtml(c.nombreFantasia || c.razonSocial)}</strong>
        <span class="selected-client__meta">${escapeHtml(c.razonSocial)} · <span class="mono">${escapeHtml(c.id)}</span></span>
      </div>
      <button type="button" class="btn btn--ghost" id="change-client">Cambiar</button>
    </div>
    <div class="order__split">
      <div class="order__products">
        <div class="search">
          <label class="field">
            <span class="field__label">Buscar producto</span>
            <input class="input input--search" id="prod-q" type="search" placeholder="SKU, código de barras, marca o descripción" autocomplete="off" spellcheck="false" enterkeyhint="search">
          </label>
          <p class="search__meta" id="prod-meta" aria-live="polite"></p>
        </div>
        <ul class="list list--products" id="prod-list"></ul>
      </div>
      <aside class="order__cart" aria-label="Carrito">
        <h2 class="card__title">Carrito</h2>
        <ul class="cart" id="cart-list"></ul>
        <div class="cart__total"><span>Total</span><strong id="cart-total-side"></strong></div>
      </aside>
    </div>
    <div class="cartbar" id="cartbar">
      <div class="cartbar__info">
        <span class="cartbar__count" id="cartbar-count"></span>
        <strong class="cartbar__total" id="cartbar-total"></strong>
      </div>
      <button type="button" class="btn btn--primary btn--lg" id="to-confirm">Revisar pedido →</button>
    </div>`;

  $('#change-client').addEventListener('click', () => goStep(1));
  $('#to-confirm').addEventListener('click', () => {
    if (cartLines().length === 0) { toast('Agregá al menos un producto.', 'warn'); return; }
    goStep(3);
  });

  const input = $('#prod-q');
  const draw = () => drawProductos(normalizeText(input.value));
  input.addEventListener('input', debounce(draw, SEARCH_DEBOUNCE_MS));
  // Lector de código de barras (actúa como teclado + Enter): coincidencia exacta suma 1 unidad.
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const raw = input.value.trim();
    if (!raw) return;
    const exact = state.productos.find((p) => (p.codBarra && p.codBarra === raw) || p.sku === raw);
    if (exact) {
      setQty(exact.sku, (state.draft.items[exact.sku] || 0) + 1);
      toast(`+1 ${exact.descripcion}`, 'ok', 1800);
      input.value = '';
      draw();
    }
  });

  // Delegación de eventos para +/−, agregar y edición directa de cantidad (lista y carrito).
  const onClick = (e) => {
    const b = e.target.closest('[data-qty-op]');
    if (!b) return;
    const sku = b.dataset.sku;
    const cur = state.draft.items[sku] || 0;
    const op = b.dataset.qtyOp;
    setQty(sku, op === 'inc' ? cur + 1 : op === 'dec' ? cur - 1 : 0);
  };
  const onChange = (e) => {
    const inp = e.target.closest('input[data-qty-input]');
    if (!inp) return;
    setQty(inp.dataset.sku, clampInt(inp.value, 0, MAX_QTY));
  };
  const onFocus = (e) => { if (e.target.matches('input[data-qty-input]')) e.target.select(); };
  for (const el of [$('#prod-list'), $('#cart-list')]) {
    el.addEventListener('click', onClick);
    el.addEventListener('change', onChange);
    el.addEventListener('focusin', onFocus);
  }

  draw();
  drawCart();
  if (window.matchMedia('(min-width: 900px)').matches) input.focus();
}

/** Control +/− con campo numérico (o botón "Agregar" si la cantidad es 0). */
function qtyControl(sku, qty, label) {
  const s = escapeHtml(sku);
  if (!qty) {
    return `<button type="button" class="btn btn--primary-soft qty-add" data-qty-op="inc" data-sku="${s}" aria-label="Agregar ${escapeHtml(label)}">+ Agregar</button>`;
  }
  return `<div class="qty" role="group" aria-label="Cantidad de ${escapeHtml(label)}">
    <button type="button" class="qty__btn" data-qty-op="dec" data-sku="${s}" aria-label="Restar uno">−</button>
    <input class="qty__input" type="text" inputmode="numeric" pattern="[0-9]*" data-qty-input data-sku="${s}" value="${qty}" aria-label="Cantidad">
    <button type="button" class="qty__btn" data-qty-op="inc" data-sku="${s}" aria-label="Sumar uno">+</button>
  </div>`;
}

function productRow(p) {
  const qty = state.draft.items[p.sku] || 0;
  return `<li class="product ${qty ? 'is-in-cart' : ''}${p.esCombo ? ' product--combo' : ''}" data-row="${escapeHtml(p.sku)}">
    <div class="product__info">
      <span class="product__name">${comboBadge(p)}${escapeHtml(p.descripcion)}</span>
      ${p.esCombo ? `<span class="product__combo">${escapeHtml(comboContents(p))}</span>` : ''}
      <span class="product__meta">${escapeHtml(p.marca)} · SKU <span class="mono">${escapeHtml(p.sku)}</span>${p.codBarra ? ` · <span class="mono">${escapeHtml(p.codBarra)}</span>` : ''}</span>
      <span class="product__price">${escapeHtml(formatGs(p.precio))}${qty ? ` <span class="product__subtotal">· Subtotal ${escapeHtml(formatGs(p.precio * qty))}</span>` : ''}</span>
    </div>
    <div class="product__qty">${qtyControl(p.sku, qty, p.descripcion)}</div>
  </li>`;
}

function drawProductos(q) {
  const matches = [];
  let total = 0;
  for (const p of state.productos) {
    if (matchesQuery(p._idx, q)) {
      total++;
      if (matches.length < MAX_RESULTS) matches.push(p);
    }
  }
  $('#prod-meta').textContent = total > MAX_RESULTS
    ? `Mostrando ${MAX_RESULTS} de ${formatNum(total)} productos. Escribí más para afinar la búsqueda.`
    : total ? `${formatNum(total)} producto${total === 1 ? '' : 's'}` : '';
  $('#prod-list').innerHTML = matches.length
    ? matches.map(productRow).join('')
    : `<li class="empty empty--sm">No hay productos que coincidan con “${escapeHtml(q)}”.</li>`;
}

/** Cambia la cantidad de un SKU y actualiza solo lo necesario del DOM. */
function setQty(sku, qty) {
  qty = Math.max(0, Math.min(MAX_QTY, Math.floor(Number(qty) || 0)));
  if (qty === 0) delete state.draft.items[sku];
  else state.draft.items[sku] = qty;
  persistDraft();

  const row = document.querySelector(`#prod-list [data-row="${CSS.escape(sku)}"]`);
  const p = state.productosBySku.get(sku);
  if (row && p) {
    const hadFocus = row.contains(document.activeElement) && document.activeElement.matches('[data-qty-op]')
      ? document.activeElement.dataset.qtyOp : null;
    const tmp = document.createElement('ul');
    tmp.innerHTML = productRow(p);
    const fresh = tmp.firstElementChild;
    row.replaceWith(fresh);
    // Mantener el foco en el botón pulsado (accesibilidad / uso rápido con teclado).
    if (hadFocus) {
      const target = fresh.querySelector(`[data-qty-op="${hadFocus}"]`) || fresh.querySelector('[data-qty-op]');
      target && target.focus();
    }
  }
  drawCart();
}

function drawCart() {
  const { lines, items, unidades, total } = cartTotals();
  const list = $('#cart-list');
  if (list) {
    list.innerHTML = lines.length
      ? lines.map((l) => `<li class="cart__item">
          <div class="cart__info">
            <span class="cart__name">${comboBadge(l)}${escapeHtml(l.descripcion)}</span>
            <span class="cart__meta">${escapeHtml(formatGs(l.precio))} c/u · <strong>${escapeHtml(formatGs(l.subtotal))}</strong></span>
          </div>
          ${qtyControl(l.sku, l.cantidad, l.descripcion)}
          <button type="button" class="icon-btn icon-btn--sm" data-qty-op="del" data-sku="${escapeHtml(l.sku)}" aria-label="Quitar ${escapeHtml(l.descripcion)}">✕</button>
        </li>`).join('')
      : '<li class="empty empty--sm">El carrito está vacío. Buscá productos y tocá “+ Agregar”.</li>';
  }
  const side = $('#cart-total-side');
  if (side) side.textContent = formatGs(total);
  const cnt = $('#cartbar-count');
  if (cnt) cnt.textContent = items ? `${items} producto${items === 1 ? '' : 's'} · ${formatNum(unidades)} u.` : 'Carrito vacío';
  const tot = $('#cartbar-total');
  if (tot) tot.textContent = formatGs(total);
  const btn = $('#to-confirm');
  if (btn) btn.disabled = items === 0;
}

// ---------- Paso 3: Confirmar ----------
function renderStepConfirmar() {
  const c = state.draft.cliente;
  const { lines, items, unidades, total } = cartTotals();
  const body = $('#step-body');
  body.innerHTML = `
    <div class="confirm card">
      <div class="confirm__client">
        <span class="selected-client__label">Cliente</span>
        <strong class="selected-client__name">${escapeHtml(c.nombreFantasia || c.razonSocial)}</strong>
        <span class="selected-client__meta">${escapeHtml(c.razonSocial)} · <span class="mono">${escapeHtml(c.id)}</span></span>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead><tr><th scope="col">Producto</th><th scope="col" class="num">Cant.</th><th scope="col" class="num">Precio</th><th scope="col" class="num">Subtotal</th></tr></thead>
          <tbody>${lines.map((l) => `<tr>
            <td><span class="cell-main">${comboBadge(l)}${escapeHtml(l.descripcion)}</span><span class="cell-sub">${escapeHtml(l.marca)} · ${escapeHtml(l.sku)}</span>${l.esCombo ? `<span class="cell-sub">${escapeHtml(l.contenido)}</span>` : ''}</td>
            <td class="num">${escapeHtml(formatNum(l.cantidad))}</td>
            <td class="num">${escapeHtml(formatGs(l.precio))}</td>
            <td class="num">${escapeHtml(formatGs(l.subtotal))}</td>
          </tr>`).join('')}</tbody>
          <tfoot><tr><th scope="row" colspan="3">Total · ${items} producto${items === 1 ? '' : 's'}, ${escapeHtml(formatNum(unidades))} u.</th><td class="num total-cell">${escapeHtml(formatGs(total))}</td></tr></tfoot>
        </table>
      </div>
      <label class="field">
        <span class="field__label">Observaciones (opcional)</span>
        <textarea class="input textarea" id="obs" rows="3" maxlength="500" placeholder="Ej.: entregar el lunes, contacto en sucursal, etc.">${escapeHtml(state.draft.observaciones)}</textarea>
      </label>
      <p class="form__hint">Los precios son los de la lista del evento. El pedido se guarda en la tablet y se envía automáticamente cuando haya señal.</p>
    </div>
    <div class="cartbar">
      <button type="button" class="btn btn--ghost btn--lg" id="back-products">← Editar productos</button>
      <button type="button" class="btn btn--primary btn--lg" id="confirm-btn">Confirmar pedido · ${escapeHtml(formatGs(total))}</button>
    </div>`;

  $('#obs').addEventListener('input', (e) => { state.draft.observaciones = e.target.value; persistDraft(); });
  $('#back-products').addEventListener('click', () => goStep(2));
  $('#confirm-btn').addEventListener('click', confirmOrder);
}

/** Guarda el pedido con su correlativo (atómico) y lo pone en la cola. */
async function confirmOrder() {
  if (state.submitting) return;            // evita doble toque
  const btn = $('#confirm-btn');
  const obs = $('#obs');
  if (obs) state.draft.observaciones = obs.value;
  const { lines, total } = cartTotals();
  if (!state.draft.cliente || lines.length === 0) { toast('El pedido está incompleto.', 'warn'); return; }

  state.submitting = true;
  btn.disabled = true; btn.classList.add('is-loading'); btn.textContent = 'Guardando…';
  try {
    const user = state.session.user;
    const serverCorr = await db.getMeta('serverCorrelativo', 0);
    const now = new Date().toISOString();
    const cliente = state.draft.cliente;
    const observaciones = (state.draft.observaciones || '').trim().slice(0, 500);
    const pedido = await db.savePedidoConCorrelativo((n) => ({
      nroPedido: `EXPO-${user.id}-${pad(n, 4)}`,
      correlativo: n,
      idVendedor: user.id,
      fechaHora: now,
      codCliente: cliente.id,
      cliente,
      observaciones,
      lineas: lines.map(({ sku, descripcion, marca, precio, cantidad, subtotal, esCombo, contenido }) => ({ sku, descripcion, marca, precio, cantidad, subtotal, esCombo, contenido })),
      total,
      estado: db.ESTADOS.PENDIENTE,
      mensaje: '',
      intentos: 0,
      creadoEn: now,
    }), serverCorr);

    // El pedido ya está seguro en IndexedDB: limpiar borrador.
    persistDraft.cancel();
    state.draft = emptyDraft();
    await db.delMeta(DRAFT_KEY);
    await updatePendingBadge();
    renderSuccess(pedido);
    runSync(false); // intento inmediato (sin bloquear la UI)
  } catch (err) {
    console.error(err);
    toast(`No se pudo guardar el pedido: ${err.message || err}`, 'error', 6000);
    btn.disabled = false; btn.classList.remove('is-loading'); btn.textContent = `Confirmar pedido · ${formatGs(total)}`;
  } finally {
    state.submitting = false;
  }
}

function renderSuccess(p) {
  main.innerHTML = `
    <section class="screen success" aria-labelledby="ok-title">
      <div class="success__card">
        <div class="success__icon" aria-hidden="true">✓</div>
        <h1 id="ok-title">Pedido guardado</h1>
        <p class="success__nro mono">${escapeHtml(p.nroPedido)}</p>
        <p class="success__client">${escapeHtml(p.cliente.nombreFantasia || p.cliente.razonSocial)}</p>
        <p class="success__total">${escapeHtml(formatGs(p.total))}</p>
        <p class="form__hint" id="success-status">Se está enviando… si no hay señal, se enviará automáticamente más tarde.</p>
        <div class="success__actions">
          <button class="btn btn--primary btn--lg" type="button" data-nav="#/nuevo">Nuevo pedido</button>
          <button class="btn btn--ghost btn--lg" type="button" data-nav="#/pedidos">Ver mis pedidos</button>
        </div>
      </div>
    </section>`;
  main.focus();
}

// Actualiza el texto de la pantalla de éxito cuando termina el envío.
syncEvents.addEventListener('change', async (e) => {
  const el = $('#success-status');
  if (!el || e.detail.sending) return;
  const nro = $('.success__nro') && $('.success__nro').textContent;
  const p = nro && (await db.get(db.STORES.PEDIDOS, nro));
  if (!p) return;
  if (p.estado === db.ESTADOS.ENVIADO) { el.textContent = '✅ Enviado al servidor.'; el.className = 'form__hint is-ok'; }
  else if (p.estado === db.ESTADOS.ERROR) { el.textContent = `⚠️ El servidor lo rechazó: ${p.mensaje}`; el.className = 'form__hint is-error'; }
  else { el.textContent = '⏳ Guardado en la tablet. Se enviará cuando haya señal.'; el.className = 'form__hint is-warn'; }
});

// =====================================================================
// Pantalla: Mis pedidos
// =====================================================================

let pedidosFilter = 'todos';
const ESTADO_UI = {
  pendiente: { label: 'Pendiente', icon: '⏳', cls: 'chip--pending' },
  enviado: { label: 'Enviado', icon: '✅', cls: 'chip--ok' },
  error: { label: 'Error', icon: '⚠️', cls: 'chip--error' },
};

async function renderPedidos() {
  if (!isVendor()) return;
  const openSet = new Set([...document.querySelectorAll('.order-item[open]')].map((d) => d.dataset.nro));
  const all = (await db.getAll(db.STORES.PEDIDOS)).sort((a, b) => String(b.fechaHora).localeCompare(String(a.fechaHora)));
  if (!location.hash.startsWith('#/pedidos')) return; // el usuario ya cambió de pantalla
  const counts = { todos: all.length, pendiente: 0, enviado: 0, error: 0 };
  all.forEach((p) => { counts[p.estado] = (counts[p.estado] || 0) + 1; });
  const list = pedidosFilter === 'todos' ? all : all.filter((p) => p.estado === pedidosFilter);
  const totalGs = all.reduce((a, p) => a + (Number(p.total) || 0), 0);

  main.innerHTML = `
    <section class="screen" aria-labelledby="ped-title">
      <div class="screen__head">
        <button class="btn btn--ghost" type="button" data-nav="#/home">← Inicio</button>
        <h1 id="ped-title">Mis pedidos</h1>
        <button class="btn btn--primary" type="button" id="sync-now" ${counts.pendiente + counts.error === 0 ? 'disabled' : ''}>Enviar pendientes</button>
      </div>
      <p class="note">Los pedidos enviados no se pueden modificar desde la app. Las modificaciones las hace solo el supervisor en el Sheet.</p>
      <div class="filters" role="tablist" aria-label="Filtrar por estado">
        ${[['todos', 'Todos'], ['pendiente', 'Pendientes'], ['enviado', 'Enviados'], ['error', 'Con error']].map(([k, l]) => `
          <button type="button" role="tab" class="filter ${pedidosFilter === k ? 'is-active' : ''}" aria-selected="${pedidosFilter === k}" data-filter="${k}">${l} <span class="filter__n">${counts[k] || 0}</span></button>`).join('')}
      </div>
      <p class="search__meta">${formatNum(all.length)} pedidos en esta tablet · ${escapeHtml(formatGs(totalGs))}</p>
      <div class="orders" id="orders">
        ${list.length ? list.map((p) => pedidoItem(p, openSet.has(p.nroPedido))).join('') : `<div class="empty"><p>${all.length ? 'No hay pedidos con este estado.' : 'Todavía no cargaste pedidos.'}</p>${all.length ? '' : '<button class="btn btn--primary btn--lg" type="button" data-nav="#/nuevo">Nuevo pedido</button>'}</div>`}
      </div>
    </section>`;

  $('#sync-now').addEventListener('click', async (e) => {
    const b = e.currentTarget;
    b.disabled = true; b.classList.add('is-loading');
    // Reencolar también los que tienen error antes de enviar.
    const errs = await db.getPedidosByEstado(db.ESTADOS.ERROR);
    if (errs.length) await db.updatePedidos(errs.map((p) => ({ nroPedido: p.nroPedido, changes: { estado: db.ESTADOS.PENDIENTE } })));
    await runSync(true);
    renderPedidos();
  });
  main.querySelector('.filters').addEventListener('click', (e) => {
    const f = e.target.closest('[data-filter]');
    if (!f) return;
    pedidosFilter = f.dataset.filter;
    renderPedidos();
  });
  $('#orders').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-retry]');
    if (!b) return;
    if (state.authExpired) { reloginFlow(); return; }
    b.disabled = true; b.classList.add('is-loading');
    const res = await retryPedido(b.dataset.retry);
    if (res && res.fallo) toast(res.code === 'NETWORK' ? 'Sin conexión. Se enviará automáticamente.' : res.fallo, 'warn');
    renderPedidos();
  });
}

function pedidoItem(p, open) {
  const ui = ESTADO_UI[p.estado] || ESTADO_UI.pendiente;
  const c = p.cliente || {};
  return `<details class="order-item order-item--${escapeHtml(p.estado)}" data-nro="${escapeHtml(p.nroPedido)}" ${open ? 'open' : ''}>
    <summary class="order-item__sum">
      <span class="order-item__main">
        <span class="order-item__client">${escapeHtml(c.nombreFantasia || c.razonSocial || p.codCliente)}</span>
        <span class="order-item__meta"><span class="mono">${escapeHtml(p.nroPedido)}</span> · ${escapeHtml(formatDateTime(p.fechaHora))} · ${p.lineas.length} prod.</span>
      </span>
      <span class="order-item__right">
        <strong class="order-item__total">${escapeHtml(formatGs(p.total))}</strong>
        <span class="chip ${ui.cls}"><span aria-hidden="true">${ui.icon}</span> ${ui.label}</span>
      </span>
    </summary>
    <div class="order-item__body">
      ${p.estado === 'error' ? `<p class="notice notice--error"><strong>Motivo:</strong> ${escapeHtml(p.mensaje || 'Error desconocido')}</p>` : ''}
      ${p.estado === 'pendiente' && p.ultimoFallo ? `<p class="notice notice--warn">Último intento ${escapeHtml(timeAgo(p.ultimoIntento))}: ${escapeHtml(p.ultimoFallo)}</p>` : ''}
      ${p.estado === 'enviado' && p.mensaje ? `<p class="note">${escapeHtml(p.mensaje)}</p>` : ''}
      <p class="order-item__clientfull">${escapeHtml(c.razonSocial || '')} · <span class="mono">${escapeHtml(p.codCliente)}</span></p>
      <div class="table-wrap"><table class="table table--compact">
        <thead><tr><th scope="col">Producto</th><th scope="col" class="num">Cant.</th><th scope="col" class="num">Precio</th><th scope="col" class="num">Subtotal</th></tr></thead>
        <tbody>${p.lineas.map((l) => `<tr>
          <td><span class="cell-main">${comboBadge(l)}${escapeHtml(l.descripcion)}</span><span class="cell-sub">${escapeHtml(l.sku)}</span>${l.esCombo && l.contenido ? `<span class="cell-sub">${escapeHtml(l.contenido)}</span>` : ''}</td>
          <td class="num">${escapeHtml(formatNum(l.cantidad))}</td>
          <td class="num">${escapeHtml(formatGs(l.precio))}</td>
          <td class="num">${escapeHtml(formatGs(l.subtotal))}</td></tr>`).join('')}</tbody>
      </table></div>
      ${p.observaciones ? `<p><strong>Observaciones:</strong> ${escapeHtml(p.observaciones)}</p>` : ''}
      ${p.estado !== 'enviado' ? `<button type="button" class="btn btn--primary" data-retry="${escapeHtml(p.nroPedido)}">Reintentar envío</button>` : ''}
    </div>
  </details>`;
}

// =====================================================================
// Pantalla: Dashboard / Mi resumen
// =====================================================================

function renderDash(vendorView) {
  renderDashboard(main, { user: state.session.user, toast, isVendor: vendorView });
}

// =====================================================================
// Arranque
// =====================================================================

let bgStarted = false;
function startBackgroundTasks() {
  if (bgStarted) return;
  bgStarted = true;
  checkConnection().then(() => runSync(false));
  updatePendingBadge();
  setInterval(() => runSync(false), SYNC_INTERVAL_MS);
  setInterval(() => { if (document.visibilityState === 'visible') checkConnection(); }, PING_INTERVAL_MS);
}

window.addEventListener('online', async () => {
  state.online = true;
  await checkConnection();
  if (isOnline()) runSync(true, false).catch(() => {});
});
window.addEventListener('offline', () => {
  state.online = false;
  state.serverReachable = false;
  updateConnBadge();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.session) {
    checkConnection().then(() => { runSync(false); autoRefreshCatalog(); });
  }
});

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Ruta relativa: funciona en la raíz o en un subpath de GitHub Pages.
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw && nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          toast('Hay una versión nueva de la app. Cerrala y abrila de nuevo para usarla.', 'info', 8000);
        }
      });
    });
  }).catch((err) => console.warn('No se pudo registrar el service worker', err));
}

async function init() {
  registerServiceWorker();
  updateConnBadge();
  try {
    const session = await db.getMeta('session');
    if (session && session.token && session.user) {
      state.session = session;
      api.setToken(session.token);
      const exp = tokenExpMs(session.token);
      if (exp && exp < Date.now()) state.authExpired = true;
      await loadMasterData();
      applySessionToHeader();
      startBackgroundTasks();
      autoRefreshCatalog(); // en segundo plano: no se espera
    }
  } catch (err) {
    console.error(err);
    toast('No se pudo abrir la base local del navegador. ¿Modo incógnito?', 'error', 8000);
  }
  updateBanner();
  render();
}

init();
