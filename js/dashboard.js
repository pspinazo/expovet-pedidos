/**
 * Dashboard de ventas (supervisor: su equipo; vendedor: "Mi resumen").
 * Gráficos hechos con HTML/CSS puro (sin librerías) para funcionar offline.
 * El último dashboard recibido se guarda en IndexedDB y se muestra sin red con un aviso.
 */
import * as db from './db.js';
import * as api from './api.js';
import { escapeHtml, formatGs, formatNum, formatDateTime, timeAgo } from './utils.js';

const CACHE_KEY = 'dashboardCache';
let agoTimer = null;

/**
 * Pinta el dashboard dentro de `root`.
 * @param {HTMLElement} root
 * @param {{user:object, toast:Function, isVendor:boolean}} ctx
 */
export async function renderDashboard(root, ctx) {
  const titulo = ctx.isVendor ? 'Mi resumen' : `Dashboard · ${ctx.user.canal || 'Equipo'}`;
  root.innerHTML = `
    <section class="screen dash" aria-labelledby="dash-title">
      <div class="screen__head">
        ${ctx.isVendor ? '<button class="btn btn--ghost" type="button" data-nav="#/home">← Inicio</button>' : ''}
        <h1 id="dash-title">${escapeHtml(titulo)}</h1>
      </div>
      <div class="dash__toolbar">
        <button class="btn btn--primary btn--lg" type="button" id="dash-refresh">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          Actualizar datos
        </button>
        <p class="dash__ago" id="dash-ago" aria-live="polite"></p>
      </div>
      <div id="dash-notice"></div>
      <div id="dash-body"><div class="empty"><span class="spinner" aria-hidden="true"></span> Cargando datos…</div></div>
    </section>`;

  const btn = root.querySelector('#dash-refresh');
  btn.addEventListener('click', () => load(root, ctx, { force: true }));

  // Primero mostramos lo guardado (instantáneo) y después pedimos datos frescos.
  const cached = await db.getMeta(CACHE_KEY);
  if (cached && cached.uid === ctx.user.id) paint(root, cached.data, cached.savedAt, ctx);
  await load(root, ctx, { force: false, hasCache: !!cached });
}

/** Detiene el contador "hace X min" al salir de la pantalla. */
export function stopDashboard() {
  clearInterval(agoTimer);
  agoTimer = null;
}

async function load(root, ctx, { force }) {
  const btn = root.querySelector('#dash-refresh');
  const notice = root.querySelector('#dash-notice');
  if (!btn) return;
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    const data = await api.dashboard();
    const savedAt = new Date().toISOString();
    await db.setMeta(CACHE_KEY, { uid: ctx.user.id, data, savedAt });
    notice.innerHTML = '';
    paint(root, data, savedAt, ctx);
    if (force) ctx.toast('Datos actualizados', 'ok');
  } catch (err) {
    const cached = await db.getMeta(CACHE_KEY);
    const hasCache = cached && cached.uid === ctx.user.id;
    const offline = err.code === 'NETWORK' || err.code === 'TIMEOUT';
    notice.innerHTML = `<div class="notice notice--warn" role="status">
        <strong>${offline ? 'Sin conexión.' : 'No se pudieron actualizar los datos.'}</strong>
        ${hasCache ? 'Se muestra el último dato guardado.' : 'Todavía no hay datos guardados en este equipo.'}
        <span class="notice__detail">${escapeHtml(err.message)}</span>
      </div>`;
    if (!hasCache) {
      root.querySelector('#dash-body').innerHTML = `<div class="empty"><p>Conectate a internet y pulsá <strong>Actualizar datos</strong>.</p></div>`;
    }
    if (force) ctx.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-loading');
  }
}

/** Dibuja todo el contenido del dashboard. */
function paint(root, data, savedAt, ctx) {
  const body = root.querySelector('#dash-body');
  if (!body || !data) return;
  const t = data.totales || {};
  const venta = Number(t.ventaGs) || 0;
  const pedidos = Number(t.pedidos) || 0;
  const ticket = pedidos > 0 ? venta / pedidos : 0;

  body.innerHTML = `
    <div class="kpis">
      ${kpi('Venta total', formatGs(venta), 'kpi--main')}
      ${kpi('Pedidos', formatNum(pedidos))}
      ${kpi('Clientes atendidos', formatNum(t.clientesAtendidos))}
      ${kpi('Ticket promedio', formatGs(ticket))}
    </div>
    <div class="dash__grid">
      ${ctx.isVendor ? '' : `<section class="card">
        <h2 class="card__title">Venta por vendedor</h2>
        ${barsVendedores(data.porVendedor || [])}
      </section>`}
      <section class="card">
        <h2 class="card__title">Día 1 vs Día 2</h2>
        ${diasCompare(data.porDia || [])}
      </section>
      <section class="card card--wide">
        <h2 class="card__title">Top 10 productos</h2>
        ${tablaTop(data.topProductos || [])}
      </section>
      ${(data.topCombos || []).length ? `<section class="card card--wide" id="dash-combos">
        <h2 class="card__title">Combos vendidos</h2>
        ${tablaCombos(data.topCombos)}
      </section>` : ''}
      <section class="card card--wide">
        <h2 class="card__title">Últimos pedidos</h2>
        ${tablaUltimos(data.ultimosPedidos || [], ctx.isVendor)}
      </section>
    </div>
    <p class="dash__foot">Datos del servidor generados ${escapeHtml(data.generado ? formatDateTime(data.generado) : '—')} · No incluye pedidos anulados ni los que aún no se enviaron desde las tablets.</p>`;

  // "Actualizado hace X min" se refresca solo cada 30 s.
  const agoEl = root.querySelector('#dash-ago');
  const tick = () => { if (agoEl.isConnected) agoEl.textContent = `Actualizado ${timeAgo(savedAt)}`; };
  tick();
  clearInterval(agoTimer);
  agoTimer = setInterval(tick, 30000);
}

function kpi(label, value, extra = '') {
  return `<div class="kpi ${extra}"><span class="kpi__label">${escapeHtml(label)}</span><span class="kpi__value">${escapeHtml(value)}</span></div>`;
}

/** Barras horizontales ordenadas de mayor a menor, con valor rotulado. */
function barsVendedores(rows) {
  if (!rows.length) return emptyBlock('Sin vendedores para mostrar.');
  const sorted = [...rows].sort((a, b) => (Number(b.ventaGs) || 0) - (Number(a.ventaGs) || 0));
  const max = Math.max(1, ...sorted.map((r) => Number(r.ventaGs) || 0));
  return `<ol class="bars" aria-label="Venta por vendedor, de mayor a menor">
    ${sorted.map((r) => {
      const v = Number(r.ventaGs) || 0;
      const pct = (v / max) * 100;
      return `<li class="bars__row">
        <span class="bars__label">${escapeHtml(r.nombre || r.idVendedor)}</span>
        <span class="bars__track"><span class="bars__fill${v === 0 ? ' is-zero' : ''}" style="width:${pct.toFixed(2)}%"></span></span>
        <span class="bars__value">${escapeHtml(formatGs(v))}<small>${escapeHtml(formatNum(r.pedidos))} ped.</small></span>
      </li>`;
    }).join('')}
  </ol>`;
}

/** Comparación de los dos días del evento. */
function diasCompare(rows) {
  const byDia = (name) => rows.find((r) => r.dia === name) || { dia: name, ventaGs: 0, pedidos: 0 };
  const d1 = byDia('Día 1');
  const d2 = byDia('Día 2');
  const max = Math.max(1, Number(d1.ventaGs) || 0, Number(d2.ventaGs) || 0);
  const v1 = Number(d1.ventaGs) || 0;
  const v2 = Number(d2.ventaGs) || 0;
  let delta = '';
  if (v1 > 0 && v2 > 0) {
    const pct = ((v2 - v1) / v1) * 100;
    delta = `<p class="days__delta ${pct >= 0 ? 'is-up' : 'is-down'}">Día 2 vs Día 1: ${pct >= 0 ? '▲ +' : '▼ '}${escapeHtml(pct.toFixed(1).replace('.', ','))}%</p>`;
  }
  const col = (d, label, sub, cls) => {
    const v = Number(d.ventaGs) || 0;
    return `<div class="days__col">
      <span class="days__value">${escapeHtml(formatGs(v))}</span>
      <span class="days__bar-wrap"><span class="days__bar ${cls}" style="height:${((v / max) * 100).toFixed(2)}%"></span></span>
      <span class="days__label">${escapeHtml(label)}</span>
      <span class="days__sub">${escapeHtml(sub)} · ${escapeHtml(formatNum(d.pedidos))} pedidos</span>
    </div>`;
  };
  return `<div class="days">${col(d1, 'Día 1', 'Mar 3/11', 'days__bar--1')}${col(d2, 'Día 2', 'Mié 4/11', 'days__bar--2')}</div>${delta}`;
}

function tablaTop(rows) {
  if (!rows.length) return emptyBlock('Todavía no hay productos vendidos.');
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">#</th><th scope="col">Producto</th><th scope="col" class="num">Cant.</th><th scope="col" class="num">Venta</th></tr></thead>
    <tbody>${rows.slice(0, 10).map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td><span class="cell-main">${escapeHtml(r.descripcion)}</span><span class="cell-sub">${escapeHtml(r.sku)}</span></td>
      <td class="num">${escapeHtml(formatNum(r.cantidad))}</td>
      <td class="num">${escapeHtml(formatGs(r.ventaGs))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

/** Combos vendidos: packs (no unidades de componentes) y venta en Gs. */
function tablaCombos(rows) {
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">#</th><th scope="col">Combo</th><th scope="col" class="num">Packs</th><th scope="col" class="num">Venta</th></tr></thead>
    <tbody>${rows.slice(0, 10).map((r, i) => `<tr>
      <td>${i + 1}</td>
      <td><span class="cell-main">${escapeHtml(r.descripcion)}</span><span class="cell-sub">${escapeHtml(r.sku)}</span></td>
      <td class="num">${escapeHtml(formatNum(r.cantidad))}</td>
      <td class="num">${escapeHtml(formatGs(r.ventaGs))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function tablaUltimos(rows, isVendor) {
  if (!rows.length) return emptyBlock('Todavía no hay pedidos registrados.');
  return `<div class="table-wrap"><table class="table">
    <thead><tr><th scope="col">Hora</th><th scope="col">Pedido</th><th scope="col">Cliente</th>${isVendor ? '' : '<th scope="col">Vendedor</th>'}<th scope="col" class="num">Total</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${escapeHtml(formatDateTime(r.fechaHora))}</td>
      <td class="mono">${escapeHtml(r.nroPedido)}</td>
      <td>${escapeHtml(r.cliente)}</td>
      ${isVendor ? '' : `<td>${escapeHtml(r.vendedor)}</td>`}
      <td class="num">${escapeHtml(formatGs(r.ventaGs))}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function emptyBlock(msg) {
  return `<p class="empty empty--sm">${escapeHtml(msg)}</p>`;
}
