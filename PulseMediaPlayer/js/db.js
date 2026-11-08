// Pulse storage: IndexedDB with two stores.
//   tracks -> small metadata records (title, artist, cover thumbnail...)
//   files  -> the audio Blob itself, keyed by track id
const DB_NAME = 'afrobox';
const DB_VERSION = 1;
let dbPromise;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('tracks', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function addTrack(meta, blob) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    let id;
    const req = tx.objectStore('tracks').add(meta);
    req.onsuccess = () => {
      id = req.result;
      tx.objectStore('files').put(blob, id);
    };
    tx.oncomplete = () => resolve(id);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Could not save track'));
  });
}

export async function getAllTracks() {
  const db = await open();
  return wrap(db.transaction('tracks').objectStore('tracks').getAll());
}

export async function getFile(id) {
  const db = await open();
  return wrap(db.transaction('files').objectStore('files').get(id));
}

export async function deleteTrack(id) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('tracks').delete(id);
    tx.objectStore('files').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export async function clearAll() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tracks', 'files'], 'readwrite');
    tx.objectStore('tracks').clear();
    tx.objectStore('files').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

// Ask the browser not to evict our data when storage is tight.
export async function requestPersistence() {
  try { if (navigator.storage?.persist) return await navigator.storage.persist(); } catch {}
  return false;
}
