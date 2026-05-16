// web/src/inventory-store.ts — 現有モジュールデータ用 IndexedDB ストア
import type { OcrGroup } from "./ocr-store";

const DB_NAME = "inventory-store";
const DB_VERSION = 1;
const STORE_NAME = "inventoryData";
const DATA_KEY = "data";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface InventoryData {
  groups: OcrGroup[];
}

export async function saveInventory(data: InventoryData): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, DATA_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function loadInventory(): Promise<InventoryData | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(DATA_KEY);
    req.onsuccess = () => {
      db.close();
      const result = req.result;
      if (!result) { resolve(null); return; }
      resolve(result);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function deleteInventory(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(DATA_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}
