import { previewSeed } from "./neuron-preview.js";

const DATABASE = "latent-field-neuron-previews";
const PREFERENCE = "latent-field-save-neuron-previews";
export const NEURON_PREVIEW_CACHE_LIMIT = 4096;
const MAX_BYTES = 64 * 1024 * 1024;

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error || new Error("Preview storage unavailable"));
  });
}

function validRecord(record, namespace) {
  const match = /^(mixed_[567][a-e])_(-?\d+)$/.exec(record?.key);
  return (
    match &&
    record.namespace === namespace &&
    Number(match[2]) >= -1 &&
    Number(match[2]) < 2048 &&
    record.seed === previewSeed(match[1], Number(match[2])) &&
    typeof record.url === "string" &&
    /^data:image\/webp;base64,[A-Za-z0-9+/]+=*$/.test(record.url) &&
    record.url.length <= 256 * 1024 &&
    Number.isFinite(record.usedAt)
  );
}

// A separate database keeps clearing previews independent of saved runs/models.
// All writes are serialized; an epoch prevents queued saves from undoing Clear.
export class NeuronPreviewCache {
  constructor({ maxEntries = NEURON_PREVIEW_CACHE_LIMIT } = {}) {
    this._maxEntries =
      Number.isInteger(maxEntries) && maxEntries > 0
        ? Math.min(maxEntries, NEURON_PREVIEW_CACHE_LIMIT)
        : NEURON_PREVIEW_CACHE_LIMIT;
    this.enabled = true;
    try {
      this.enabled = globalThis.localStorage?.getItem(PREFERENCE) !== "off";
    } catch {
      // Session previews still work when browser storage is restricted.
    }
    try {
      this.available = Boolean(globalThis.indexedDB);
    } catch {
      this.available = false;
    }
    this._namespace = null;
    this._records = new Map();
    this._listeners = new Set();
    this._task = Promise.resolve();
    this._epoch = 0;
    this._database = null;
  }

  get status() {
    return {
      enabled: this.enabled,
      available: this.available,
      count: this._records.size,
      limit: this._maxEntries,
    };
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  _notify() {
    for (const listener of this._listeners) listener(this.status);
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this._epoch += 1;
    try {
      globalThis.localStorage?.setItem(PREFERENCE, this.enabled ? "on" : "off");
    } catch {
      // The preference can still apply for this visit.
    }
    this._notify();
  }

  unavailable() {
    this.available = false;
    this._notify();
  }

  _open() {
    if (!this._database) {
      this._database = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("previews", { keyPath: "key" });
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => db.close();
          resolve(db);
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Preview storage busy"));
      });
    }
    return this._database;
  }

  _enqueue(operation, fallback) {
    const result = this._task.then(operation).catch(() => {
      this.unavailable();
      return fallback;
    });
    this._task = result;
    return result;
  }

  load(namespace) {
    const epoch = this._epoch;
    this._namespace = namespace;
    return this._enqueue(async () => {
      if (!this.enabled || !this.available || epoch !== this._epoch) return [];
      const db = await this._open();
      if (epoch !== this._epoch) return [];
      const transaction = db.transaction("previews", "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore("previews");
      const request = store.getAll();
      let records = [];
      request.onsuccess = () => {
        try {
          let bytes = 0;
          for (const record of request.result.sort(
            (a, b) => b.usedAt - a.usedAt,
          )) {
            if (
              validRecord(record, namespace) &&
              records.length < this._maxEntries &&
              bytes + record.url.length * 2 <= MAX_BYTES
            ) {
              bytes += record.url.length * 2;
              records.push(record);
            } else store.delete(record.key);
          }
        } catch {
          transaction.abort();
        }
      };
      await done;
      if (epoch !== this._epoch) return [];
      this._records = new Map(records.map((record) => [record.key, record]));
      this._notify();
      return records;
    }, []);
  }

  save(key, url, seed) {
    const epoch = this._epoch;
    const namespace = this._namespace;
    return this._enqueue(async () => {
      if (
        !namespace ||
        !this.enabled ||
        !this.available ||
        epoch !== this._epoch
      )
        return;
      const record = { key, url, seed, namespace, usedAt: Date.now() };
      if (!validRecord(record, namespace)) return;
      const db = await this._open();
      if (epoch !== this._epoch) return;
      const transaction = db.transaction("previews", "readwrite");
      const done = transactionDone(transaction);
      const store = transaction.objectStore("previews");
      const request = store.getAll();
      let records;
      request.onsuccess = () => {
        try {
          records = new Map();
          for (const item of request.result) {
            if (validRecord(item, namespace)) records.set(item.key, item);
            else store.delete(item.key);
          }
          const latest = Math.max(
            0,
            ...[...records.values()].map((r) => r.usedAt),
          );
          record.usedAt = Math.max(record.usedAt, latest + 1);
          records.set(key, record);
          const ordered = [...records.values()].sort(
            (a, b) => b.usedAt - a.usedAt,
          );
          let bytes = 0;
          store.put(record);
          for (const [index, item] of ordered.entries()) {
            bytes += item.url.length * 2;
            if (index >= this._maxEntries || bytes > MAX_BYTES) {
              store.delete(item.key);
              records.delete(item.key);
            }
          }
        } catch {
          transaction.abort();
        }
      };
      await done;
      if (epoch !== this._epoch) return;
      this._records = records;
      this._notify();
    });
  }

  clear() {
    this._epoch += 1;
    return this._enqueue(async () => {
      if (!globalThis.indexedDB) return false;
      const db = await this._open();
      const transaction = db.transaction("previews", "readwrite");
      const done = transactionDone(transaction);
      transaction.objectStore("previews").clear();
      await done;
      this.available = true;
      this._records.clear();
      this._notify();
      return true;
    }, false);
  }

  dispose() {
    this._listeners.clear();
    // Completed previews may still be committing when the view is disposed.
    void this._task
      .then(async () => {
        if (this._database) (await this._database).close();
      })
      .catch(() => {});
  }
}
