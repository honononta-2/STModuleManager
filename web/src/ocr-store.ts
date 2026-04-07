// web/src/ocr-store.ts — OCR一時保存用 IndexedDB ストア
import type { ModuleInput } from "@shared/types";
import type { RowPosition } from "./ocr";

export interface OcrGroup {
  imageUrl: string;
  modules: ModuleInput[];
  rowPositions?: RowPosition[];
  /** 各モジュールの元の行番号（画像ラベルと一致させる。削除しても詰めない） */
  originalRowIndices?: number[];
}

const DB_NAME = "ocr-temp-store";
const DB_VERSION = 1;
const STORE_NAME = "ocrGroups";
const DATA_KEY = "pending";

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

interface StoredData {
  groups: OcrGroup[];
  currentPage: number;
}

export async function saveOcrGroups(groups: OcrGroup[], currentPage: number): Promise<void> {
  const db = await openDB();
  const data: StoredData = { groups, currentPage };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(data, DATA_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function loadOcrGroups(): Promise<{ groups: OcrGroup[]; currentPage: number } | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(DATA_KEY);
    req.onsuccess = () => {
      db.close();
      const result = req.result;
      if (!result) { resolve(null); return; }
      // 旧形式（配列）との互換性
      if (Array.isArray(result)) { resolve({ groups: result, currentPage: 0 }); return; }
      resolve(result);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

export async function deleteOcrGroups(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(DATA_KEY);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  });
}

export async function hasOcrGroups(): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).count();
    req.onsuccess = () => { db.close(); resolve(req.result > 0); };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}
