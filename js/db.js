/**
 * Envoltorio mínimo de IndexedDB (sin dependencias).
 *
 * Stores:
 *  - meta      : clave/valor (sesión, correlativo, borrador del carrito, caché del dashboard...)
 *  - productos : keyPath 'sku'
 *  - clientes  : keyPath 'id'
 *  - pedidos   : keyPath 'nroPedido', índice 'estado' (pendiente | enviado | error)
 */

const DB_NAME = 'expovet-pedidos';
const DB_VERSION = 1;

export const STORES = { META: 'meta', PRODUCTOS: 'productos', CLIENTES: 'clientes', PEDIDOS: 'pedidos' };
export const ESTADOS = { PENDIENTE: 'pendiente', ENVIADO: 'enviado', ERROR: 'error' };

let dbPromise = null;

/** Abre (o crea) la base. Se reutiliza la misma conexión. */
export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.META)) db.createObjectStore(STORES.META);
      if (!db.objectStoreNames.contains(STORES.PRODUCTOS)) db.createObjectStore(STORES.PRODUCTOS, { keyPath: 'sku' });
      if (!db.objectStoreNames.contains(STORES.CLIENTES)) db.createObjectStore(STORES.CLIENTES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORES.PEDIDOS)) {
        const s = db.createObjectStore(STORES.PEDIDOS, { keyPath: 'nroPedido' });
        s.createIndex('estado', 'estado', { unique: false });
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Si otra pestaña actualiza la versión, cerramos para no bloquearla.
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => console.warn('IndexedDB bloqueada por otra pestaña');
  });
  return dbPromise;
}

/** Convierte un IDBRequest en promesa. */
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Promesa que se resuelve cuando la transacción termina (commit). */
function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
  });
}

// ---------- meta (clave/valor) ----------
export async function getMeta(key, fallback = null) {
  const db = await openDb();
  const v = await reqToPromise(db.transaction(STORES.META).objectStore(STORES.META).get(key));
  return v === undefined ? fallback : v;
}

export async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction(STORES.META, 'readwrite');
  tx.objectStore(STORES.META).put(value, key);
  return txDone(tx);
}

export async function delMeta(key) {
  const db = await openDb();
  const tx = db.transaction(STORES.META, 'readwrite');
  tx.objectStore(STORES.META).delete(key);
  return txDone(tx);
}

// ---------- genéricos ----------
export async function getAll(store) {
  const db = await openDb();
  return reqToPromise(db.transaction(store).objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDb();
  return reqToPromise(db.transaction(store).objectStore(store).get(key));
}

export async function put(store, value) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  return txDone(tx);
}

export async function count(store) {
  const db = await openDb();
  return reqToPromise(db.transaction(store).objectStore(store).count());
}

/** Reemplaza TODO el contenido de un store (catálogo/clientes) en una sola transacción. */
export async function replaceAll(store, items) {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  const os = tx.objectStore(store);
  os.clear();
  for (const it of items) os.put(it);
  return txDone(tx);
}

// ---------- pedidos ----------
export async function getPedidosByEstado(estado) {
  const db = await openDb();
  const idx = db.transaction(STORES.PEDIDOS).objectStore(STORES.PEDIDOS).index('estado');
  return reqToPromise(idx.getAll(estado));
}

export async function countPedidosByEstado(estado) {
  const db = await openDb();
  const idx = db.transaction(STORES.PEDIDOS).objectStore(STORES.PEDIDOS).index('estado');
  return reqToPromise(idx.count(estado));
}

/** Actualiza campos de varios pedidos en una única transacción. */
export async function updatePedidos(updates) {
  const db = await openDb();
  const tx = db.transaction(STORES.PEDIDOS, 'readwrite');
  const os = tx.objectStore(STORES.PEDIDOS);
  for (const { nroPedido, changes } of updates) {
    const r = os.get(nroPedido);
    r.onsuccess = () => {
      if (r.result) os.put({ ...r.result, ...changes });
    };
  }
  return txDone(tx);
}

/**
 * Guarda un pedido nuevo asignando el correlativo de forma ATÓMICA:
 * en una misma transacción lee el correlativo local, calcula
 * max(local, servidor) + 1, lo persiste y guarda el pedido.
 * Si algo falla, nada se escribe (ni correlativo ni pedido).
 *
 * @param {(correlativo:number) => object} buildPedido función que arma el pedido con el número asignado
 * @param {number} serverCorrelativo último correlativo informado por el servidor
 * @returns {Promise<object>} el pedido guardado
 */
export async function savePedidoConCorrelativo(buildPedido, serverCorrelativo = 0) {
  const db = await openDb();
  const tx = db.transaction([STORES.META, STORES.PEDIDOS], 'readwrite');
  const meta = tx.objectStore(STORES.META);
  const pedidos = tx.objectStore(STORES.PEDIDOS);
  let saved = null;

  const r = meta.get('correlativo');
  r.onsuccess = () => {
    const local = Number(r.result) || 0;
    const next = Math.max(local, Number(serverCorrelativo) || 0) + 1;
    saved = buildPedido(next);
    meta.put(next, 'correlativo');
    // add() (no put) falla si el nroPedido ya existiera: nunca se pisa un pedido.
    pedidos.add(saved);
  };
  await txDone(tx);
  return saved;
}

/**
 * Renumera un pedido cuyo número ya lo usa OTRO pedido en el servidor
 * (p. ej. el vendedor cargó pedidos en dos equipos). En una sola transacción:
 * nuevo correlativo = max(local, servidor) + 1, borra el registro viejo y
 * agrega el mismo pedido con el número nuevo, en estado pendiente.
 * @returns {Promise<string|null>} el nuevo nroPedido (null si no existía)
 */
export async function renumberPedido(nroViejo, serverCorrelativo = 0) {
  const db = await openDb();
  const tx = db.transaction([STORES.META, STORES.PEDIDOS], 'readwrite');
  const meta = tx.objectStore(STORES.META);
  const pedidos = tx.objectStore(STORES.PEDIDOS);
  let nuevo = null;
  const rp = pedidos.get(nroViejo);
  rp.onsuccess = () => {
    const viejo = rp.result;
    if (!viejo) return;
    const rc = meta.get('correlativo');
    rc.onsuccess = () => {
      const next = Math.max(Number(rc.result) || 0, Number(serverCorrelativo) || 0) + 1;
      const prefijo = String(nroViejo).replace(/-\d+$/, '');
      nuevo = `${prefijo}-${String(next).padStart(4, '0')}`;
      meta.put(next, 'correlativo');
      meta.put(Math.max(Number(serverCorrelativo) || 0, 0), 'serverCorrelativo');
      pedidos.delete(nroViejo);
      pedidos.add({
        ...viejo, nroPedido: nuevo, correlativo: next, estado: ESTADOS.PENDIENTE,
        mensaje: `Renumerado: el número ${nroViejo} ya estaba usado en el servidor`,
      });
    };
  };
  await txDone(tx);
  return nuevo;
}

/** Borra todos los datos (solo se usa al cerrar sesión sin pendientes). */
export async function clearAll() {
  const db = await openDb();
  const names = Object.values(STORES);
  const tx = db.transaction(names, 'readwrite');
  for (const n of names) tx.objectStore(n).clear();
  return txDone(tx);
}
