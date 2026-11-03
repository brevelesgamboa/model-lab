// A small persistent image cache, with a memory fallback when storage is absent.
// All data stays in this browser. Visited places reuse their exact saved pixels.
export class WorldImageStore {
  constructor({ indexedDB = globalThis.indexedDB, limit = 24 } = {}) {
    this.indexedDB = indexedDB;
    this.limit = limit;
    this.memory = new Map();
    this.opening = null;
    this.persistent = !!indexedDB;
  }
  async database() {
    if (!this.persistent) return null;
    this.opening ??= new Promise((resolve) => {
      const req = this.indexedDB.open("latent-field-dream-places", 1);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore("images", {
          keyPath: "key",
        });
        store.createIndex("used", "used");
      };
      req.onsuccess = () => {
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = req.onblocked = () => {
        this.persistent = false;
        resolve(null);
      };
    });
    return this.opening;
  }
  async get(key) {
    if (this.memory.has(key)) {
      const entry = this.memory.get(key);
      this.memory.delete(key);
      this.memory.set(key, entry);
      return entry;
    }
    const db = await this.database();
    if (!db) return null;
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readwrite"),
          store = tx.objectStore("images"),
          r = store.get(key);
        let value = null;
        r.onsuccess = () => {
          value = r.result || null;
          if (value) store.put({ ...value, used: Date.now() });
        };
        tx.oncomplete = () => resolve(value);
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.persistent = false;
      return null;
    }
  }
  async put(key, blob, metadata) {
    const entry = { key, blob, metadata, used: Date.now() };
    this.memory.set(key, entry);
    while (this.memory.size > 6)
      this.memory.delete(this.memory.keys().next().value);
    const db = await this.database();
    if (!db) return;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("images", "readwrite"),
          store = tx.objectStore("images");
        store.put(entry);
        const count = store.count();
        count.onsuccess = () => {
          let remove = Math.max(0, count.result - this.limit);
          if (!remove) return;
          const cursor = store.index("used").openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (c && remove-- > 0) {
              c.delete();
              c.continue();
            }
          };
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      this.persistent = false;
    }
  }
  async close() {
    const db = await this.opening;
    db?.close();
  }
}
export function readWorldProgress(storage, key) {
  try {
    return JSON.parse(storage.getItem(key) || "null");
  } catch {
    return null;
  }
}
export function saveWorldProgress(storage, key, value) {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}
