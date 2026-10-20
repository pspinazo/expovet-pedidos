/**
 * Cola de envío de pedidos.
 *
 * - Los pedidos se guardan primero en IndexedDB con estado 'pendiente' (nunca se pierden).
 * - processQueue() toma los pendientes (más antiguos primero) y los envía en lotes de ≤ 20.
 * - Resultado por pedido: guardado/duplicado → 'enviado'; error → 'error' (con mensaje).
 * - Falla de red/servidor: los pedidos quedan 'pendiente' y se reintenta con espera creciente
 *   (5 s, 10 s, 20 s… hasta 5 min). El botón manual ignora la espera.
 * - Los pedidos en 'error' (rechazados por el servidor) NO se reintentan solos: el vendedor
 *   pulsa "Reintentar" y vuelven a 'pendiente'.
 */
import * as db from './db.js';
import * as api from './api.js';

const BATCH_SIZE = 20;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

// Emisor de eventos para que la UI se actualice: 'change' (detail: resumen)
export const syncEvents = new EventTarget();

let running = null;          // promesa del envío en curso (evita envíos simultáneos)
let failures = 0;            // fallos consecutivos (para el backoff)
let nextAllowedAt = 0;       // timestamp antes del cual no se reintenta automáticamente

function emit(detail) {
  syncEvents.dispatchEvent(new CustomEvent('change', { detail }));
}

/** Arma el payload que espera la API (sin precios: el servidor los toma del Sheet). */
export function toWire(p) {
  return {
    nroPedido: p.nroPedido,
    fechaHora: p.fechaHora,
    codCliente: p.codCliente,
    observaciones: p.observaciones || '',
    lineas: p.lineas.map((l) => ({ sku: l.sku, cantidad: l.cantidad })),
  };
}

/** Milisegundos hasta el próximo intento automático (0 = puede intentar ya). */
export function backoffRemaining() {
  return Math.max(0, nextAllowedAt - Date.now());
}

/**
 * Procesa la cola.
 * @param {{manual?: boolean}} opts manual=true ignora la espera de backoff
 * @returns {Promise<{enviados:number, errores:number, pendientes:number, fallo?:string, code?:string, skipped?:boolean}>}
 */
export function processQueue({ manual = false } = {}) {
  if (running) return running;
  running = doProcess(manual).finally(() => { running = null; });
  return running;
}

async function doProcess(manual, pasada = 0) {
  const summary = { enviados: 0, errores: 0, pendientes: 0 };
  let renumerados = 0;

  if (!navigator.onLine) {
    summary.pendientes = await db.countPedidosByEstado(db.ESTADOS.PENDIENTE);
    summary.skipped = true;
    summary.fallo = 'Sin conexión';
    summary.code = 'NETWORK';
    emit(summary);
    return summary;
  }
  if (!manual && backoffRemaining() > 0) {
    summary.pendientes = await db.countPedidosByEstado(db.ESTADOS.PENDIENTE);
    summary.skipped = true;
    return summary;
  }

  emit({ ...summary, sending: true });

  const pendientes = (await db.getPedidosByEstado(db.ESTADOS.PENDIENTE))
    .sort((a, b) => String(a.fechaHora).localeCompare(String(b.fechaHora)));

  for (let i = 0; i < pendientes.length; i += BATCH_SIZE) {
    const lote = pendientes.slice(i, i + BATCH_SIZE);
    try {
      const data = await api.enviarPedidos(lote.map(toWire));
      const resultados = Array.isArray(data && data.resultados) ? data.resultados : [];
      const porNro = new Map(resultados.map((r) => [r.nroPedido, r]));
      const now = new Date().toISOString();
      const updates = [];

      for (const p of lote) {
        const r = porNro.get(p.nroPedido);
        if (!r) continue; // sin resultado para este pedido: queda pendiente y se reintenta
        if (r.estado === 'error' && r.conflicto) {
          // El número ya lo usa otro pedido en el servidor: se renumera y se reenvía (no se pierde).
          await db.renumberPedido(p.nroPedido, r.ultimoCorrelativo);
          renumerados++;
          continue;
        }
        if (r.estado === 'guardado' || r.estado === 'duplicado') {
          updates.push({ nroPedido: p.nroPedido, changes: { estado: db.ESTADOS.ENVIADO, enviadoEn: now, mensaje: r.estado === 'duplicado' ? 'Ya estaba registrado en el servidor' : '', intentos: (p.intentos || 0) + 1 } });
          summary.enviados++;
        } else {
          updates.push({ nroPedido: p.nroPedido, changes: { estado: db.ESTADOS.ERROR, mensaje: r.mensaje || 'El servidor rechazó el pedido', intentos: (p.intentos || 0) + 1, ultimoIntento: now } });
          summary.errores++;
        }
      }
      await db.updatePedidos(updates);
      failures = 0;
      nextAllowedAt = 0;
    } catch (err) {
      // Error de red / servidor / sesión: no se toca el estado, se programa el próximo intento.
      failures++;
      const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
      nextAllowedAt = Date.now() + wait;
      summary.fallo = err.message || 'Error al enviar';
      summary.code = err.code || 'SERVER';
      await db.updatePedidos(lote.map((p) => ({ nroPedido: p.nroPedido, changes: { intentos: (p.intentos || 0) + 1, ultimoIntento: new Date().toISOString(), ultimoFallo: summary.fallo } })));
      break;
    }
  }

  // Los renumerados quedaron pendientes: se reenvían en una segunda pasada.
  if (renumerados > 0 && pasada < 2 && !summary.fallo) {
    const extra = await doProcess(manual, pasada + 1);
    extra.enviados += summary.enviados;
    extra.errores += summary.errores;
    return extra;
  }

  summary.pendientes = await db.countPedidosByEstado(db.ESTADOS.PENDIENTE);
  emit(summary);
  return summary;
}

/** Vuelve a poner en cola un pedido con error (o pendiente) y dispara el envío. */
export async function retryPedido(nroPedido) {
  await db.updatePedidos([{ nroPedido, changes: { estado: db.ESTADOS.PENDIENTE, mensaje: '' } }]);
  return processQueue({ manual: true });
}
