// 찍은 사진 보관 (IndexedDB). 기록 하나 = { id, created, w, h, filter, amount, original: Blob, thumb: Blob }
const DB = 'filter-camera', ST = 'photos';
let dbp = null;

function db() {
  return (dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(ST, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(ST, mode);
    const req = fn(t.objectStore(ST));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });
}

export const store = {
  all: async () => ((await tx('readonly', s => s.getAll())) || []).sort((a, b) => b.id - a.id),
  get: id => tx('readonly', s => s.get(id)),
  put: rec => tx('readwrite', s => s.put(rec)),
  del: id => tx('readwrite', s => s.delete(id)),
};

let lastId = 0;
export const newId = () => (lastId = Math.max(Date.now(), lastId + 1));

try { navigator.storage?.persist?.(); } catch {}
