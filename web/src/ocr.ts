import { STAT_ICONS } from "@shared/stats";
import type { ModuleInput, StatEntry } from "@shared/types";

// --- OpenCV.js 動的ロード ---

let cvReady: Promise<void> | null = null;

function loadOpenCV(): Promise<void> {
  if (cvReady) return cvReady;
  cvReady = new Promise((resolve, reject) => {
    const win = window as any;
    if (win.cv && typeof win.cv.Mat === "function") {
      resolve();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://docs.opencv.org/4.10.0/opencv.js";
    script.async = true;
    script.onerror = () => reject(new Error("OpenCV.jsの読み込みに失敗しました"));
    document.head.appendChild(script);

    const start = Date.now();
    const poll = () => {
      if (Date.now() - start > 30000) {
        reject(new Error("OpenCV.js初期化タイムアウト"));
        return;
      }
      try {
        if (win.cv && typeof win.cv.Mat === "function") {
          const test = new win.cv.Mat();
          test.delete();
          resolve();
          return;
        }
      } catch {
        // まだ準備中
      }
      setTimeout(poll, 100);
    };
    poll();
  });
  return cvReady;
}

// --- テンプレート管理 ---

interface TemplateInfo {
  partId: number;
  grayMat: any; // グレースケール（スケール検出 + マッチング用）
  edgeMat: any; // Cannyエッジ（マッチング用）
}

let statTemplates: TemplateInfo[] = [];
let templatesLoaded = false;

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込み失敗: ${src}`));
    img.src = src;
  });
}

async function loadTemplates(): Promise<void> {
  if (templatesLoaded) return;
  const cv = (window as any).cv;

  for (const [partIdStr, iconFile] of Object.entries(STAT_ICONS)) {
    const partId = Number(partIdStr);
    const img = await loadImage(`/icons/${iconFile}`);

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);

    const mat = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

    // コントラスト正規化
    cv.equalizeHist(gray, gray);

    // Cannyエッジ
    const edge = new cv.Mat();
    cv.Canny(gray, edge, 50, 150);

    mat.delete();
    statTemplates.push({ partId, grayMat: gray, edgeMat: edge });
  }
  templatesLoaded = true;
}

// --- スケール検出（全テンプレ中央値） ---

function detectScale(grayImage: any, cv: any): number {
  const refs = statTemplates.slice(0, 5);
  if (refs.length === 0) return 0.5;

  let bestScale = 0.5;
  let bestScore = -1;

  for (let scale = 0.35; scale <= 0.65; scale += 0.02) {
    let maxScore = 0;
    for (const ref of refs) {
      const w = Math.round(ref.grayMat.cols * scale);
      const h = Math.round(ref.grayMat.rows * scale);
      if (w < 10 || h < 10 || w >= grayImage.cols || h >= grayImage.rows)
        continue;

      const resized = new cv.Mat();
      cv.resize(ref.grayMat, resized, new cv.Size(w, h));

      const result = new cv.Mat();
      cv.matchTemplate(grayImage, resized, result, cv.TM_CCOEFF_NORMED);

      const { maxVal } = cv.minMaxLoc(result);
      if (maxVal > maxScore) maxScore = maxVal;

      resized.delete();
      result.delete();
    }

    if (maxScore > bestScore) {
      bestScore = maxScore;
      bestScale = scale;
    }
  }

  return bestScale;
}

// --- 2チャンネルマッチング（エッジ40% + グレースケール60%） ---

interface Detection {
  partId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
}

function matchAllStatIcons(
  edgeImage: any,
  cv: any,
  scale: number,
  threshold: number = 0.35,
): Detection[] {
  const detections: Detection[] = [];

  for (const tmpl of statTemplates) {
    const w = Math.round(tmpl.edgeMat.cols * scale);
    const h = Math.round(tmpl.edgeMat.rows * scale);
    if (w < 5 || h < 5 || w >= edgeImage.cols || h >= edgeImage.rows)
      continue;

    const resized = new cv.Mat();
    cv.resize(tmpl.edgeMat, resized, new cv.Size(w, h));

    const result = new cv.Mat();
    cv.matchTemplate(edgeImage, resized, result, cv.TM_CCOEFF_NORMED);

    for (let row = 0; row < result.rows; row++) {
      for (let col = 0; col < result.cols; col++) {
        const score = result.floatAt(row, col);
        if (score >= threshold) {
          detections.push({ partId: tmpl.partId, x: col, y: row, w, h, score });
        }
      }
    }

    resized.delete();
    result.delete();
  }

  return nonMaxSuppression(detections);
}

// --- Non-Maximum Suppression ---

function nonMaxSuppression(detections: Detection[]): Detection[] {
  detections.sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  const suppressed = new Set<number>();

  for (let i = 0; i < detections.length; i++) {
    if (suppressed.has(i)) continue;
    kept.push(detections[i]);

    for (let j = i + 1; j < detections.length; j++) {
      if (suppressed.has(j)) continue;
      const dx = Math.abs(detections[i].x - detections[j].x);
      const dy = Math.abs(detections[i].y - detections[j].y);
      if (dx < detections[i].w * 0.5 && dy < detections[i].h * 0.5) {
        suppressed.add(j);
      }
    }
  }

  return kept;
}

// --- 行グルーピング ---

interface ModuleRow {
  y: number;
  stats: { partId: number; x: number; y: number; w: number; h: number }[];
}

function groupIntoRows(
  detections: Detection[],
  iconHeight: number,
): ModuleRow[] {
  const sorted = [...detections].sort((a, b) => a.y - b.y);
  const rows: ModuleRow[] = [];
  const threshold = iconHeight * 0.6;

  for (const det of sorted) {
    let added = false;
    for (const row of rows) {
      if (Math.abs(det.y - row.y) < threshold) {
        row.stats.push({
          partId: det.partId,
          x: det.x,
          y: det.y,
          w: det.w,
          h: det.h,
        });
        row.y =
          row.stats.reduce((sum, s) => sum + s.y, 0) / row.stats.length;
        added = true;
        break;
      }
    }
    if (!added) {
      rows.push({
        y: det.y,
        stats: [
          { partId: det.partId, x: det.x, y: det.y, w: det.w, h: det.h },
        ],
      });
    }
  }

  for (const row of rows) {
    row.stats.sort((a, b) => a.x - b.x);
  }
  rows.sort((a, b) => a.y - b.y);

  return rows;
}

// --- グリッド補完（2チャンネル） ---

function fillGridGaps(
  detections: Detection[],
  edgeImage: any,
  cv: any,
  scale: number,
  iconSize: number,
): Detection[] {
  if (detections.length < 3) return detections;

  // 列クラスタリング
  const xValues = detections.map((d) => d.x).sort((a, b) => a - b);
  const columns: number[] = [];
  for (const x of xValues) {
    if (!columns.some((cx) => Math.abs(cx - x) < iconSize * 0.5))
      columns.push(x);
  }
  columns.sort((a, b) => a - b);

  // 行クラスタリング
  const yValues = detections.map((d) => d.y).sort((a, b) => a - b);
  const rows: number[] = [];
  for (const y of yValues) {
    if (!rows.some((ry) => Math.abs(ry - y) < iconSize * 0.5))
      rows.push(y);
  }
  rows.sort((a, b) => a - b);

  console.log("[OCR] grid columns:", columns, "rows:", rows);

  const filled = [...detections];
  for (const rowY of rows) {
    for (const colX of columns) {
      const exists = detections.some(
        (d) =>
          Math.abs(d.x - colX) < iconSize * 0.5 &&
          Math.abs(d.y - rowY) < iconSize * 0.5,
      );
      if (exists) continue;

      const roiX = Math.max(0, colX - 5);
      const roiY = Math.max(0, rowY - 5);
      const roiW = Math.min(iconSize + 10, edgeImage.cols - roiX);
      const roiH = Math.min(iconSize + 10, edgeImage.rows - roiY);
      if (roiW < iconSize || roiH < iconSize) continue;

      const roi = edgeImage.roi(new cv.Rect(roiX, roiY, roiW, roiH));

      let bestScore = 0;
      let bestPartId = -1;

      for (const tmpl of statTemplates) {
        const tw = Math.round(tmpl.edgeMat.cols * scale);
        const th = Math.round(tmpl.edgeMat.rows * scale);
        if (tw > roiW || th > roiH) continue;

        const resized = new cv.Mat();
        cv.resize(tmpl.edgeMat, resized, new cv.Size(tw, th));

        const result = new cv.Mat();
        cv.matchTemplate(roi, resized, result, cv.TM_CCOEFF_NORMED);

        const { maxVal } = cv.minMaxLoc(result);
        if (maxVal > bestScore) {
          bestScore = maxVal;
          bestPartId = tmpl.partId;
        }

        resized.delete();
        result.delete();
      }

      roi.delete();

      if (bestPartId >= 0 && bestScore > 0.25) {
        console.log(
          `[OCR] grid fill: (${colX}, ${rowY}) → partId=${bestPartId} score=${bestScore.toFixed(3)}`,
        );
        filled.push({
          partId: bestPartId,
          x: colX,
          y: rowY,
          w: iconSize,
          h: iconSize,
          score: bestScore,
        });
      }
    }
  }

  return filled;
}

// --- 数値OCR ---

async function ocrNumbersForRow(
  sourceCanvas: HTMLCanvasElement,
  row: ModuleRow,
): Promise<StatEntry[]> {
  const { createWorker } = await import("tesseract.js");

  const stats: StatEntry[] = [];
  const padding = 4;

  for (const stat of row.stats) {
    const cropX = stat.x + stat.w + padding;
    const cropY = stat.y;
    const cropW = Math.round(stat.w * 1.5);
    const cropH = stat.h;

    if (
      cropX + cropW > sourceCanvas.width ||
      cropY + cropH > sourceCanvas.height
    )
      continue;

    const numCanvas = document.createElement("canvas");
    const upscale = 4;
    numCanvas.width = cropW * upscale;
    numCanvas.height = cropH * upscale;
    const ctx = numCanvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      sourceCanvas,
      cropX,
      cropY,
      cropW,
      cropH,
      0,
      0,
      numCanvas.width,
      numCanvas.height,
    );

    // 白文字を黒文字に反転
    const imageData = ctx.getImageData(0, 0, numCanvas.width, numCanvas.height);
    for (let i = 0; i < imageData.data.length; i += 4) {
      const r = imageData.data[i];
      const g = imageData.data[i + 1];
      const b = imageData.data[i + 2];
      const brightness = r * 0.299 + g * 0.587 + b * 0.114;
      const val = brightness > 120 ? 0 : 255;
      imageData.data[i] = val;
      imageData.data[i + 1] = val;
      imageData.data[i + 2] = val;
    }
    ctx.putImageData(imageData, 0, 0);

    stats.push({
      part_id: stat.partId,
      value: 0,
      _ocrCanvas: numCanvas,
    } as any);
  }

  if (stats.length === 0) return [];

  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "+0123456789",
    tessedit_pageseg_mode: "7",
  });

  for (const stat of stats) {
    const canvas = (stat as any)._ocrCanvas as HTMLCanvasElement;
    try {
      const { data } = await worker.recognize(canvas);
      const text = data.text.trim().replace(/\s/g, "");
      const match = text.match(/\+?(\d{1,2})/);
      if (match) {
        const val = parseInt(match[1], 10);
        if (val >= 1 && val <= 20) stat.value = val;
      }
    } catch {
      // OCR失敗
    }
    delete (stat as any)._ocrCanvas;
  }

  await worker.terminate();
  return stats.filter((s) => s.value > 0);
}

// --- メイン処理 ---

export interface OcrProgress {
  stage: string;
  percent: number;
}

export async function processScreenshot(
  imageSource: HTMLImageElement | HTMLCanvasElement,
  onProgress?: (p: OcrProgress) => void,
): Promise<ModuleInput[]> {
  onProgress?.({ stage: "OpenCV.js 読み込み中...", percent: 0 });
  await loadOpenCV();
  const cv = (window as any).cv;

  onProgress?.({ stage: "テンプレート読み込み中...", percent: 10 });
  await loadTemplates();

  const canvas = document.createElement("canvas");
  const imgWidth =
    imageSource instanceof HTMLImageElement
      ? imageSource.naturalWidth
      : imageSource.width;
  const imgHeight =
    imageSource instanceof HTMLImageElement
      ? imageSource.naturalHeight
      : imageSource.height;

  // 左40%切り出し
  const cropWidth = Math.round(imgWidth * 0.4);
  canvas.width = cropWidth;
  canvas.height = imgHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageSource, 0, 0, cropWidth, imgHeight, 0, 0, cropWidth, imgHeight);

  // 前処理: グレースケール → コントラスト正規化 → エッジ
  const srcMat = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  srcMat.delete();

  const grayEq = new cv.Mat();
  cv.equalizeHist(gray, grayEq);
  const edgeMat = new cv.Mat();
  cv.Canny(grayEq, edgeMat, 50, 150);
  grayEq.delete();

  // スケール検出（グレースケール、全テンプレ中央値）
  onProgress?.({ stage: "スケール検出中...", percent: 20 });
  const scale = detectScale(gray, cv);
  console.log("[OCR] detected scale:", scale);
  gray.delete();

  // 2チャンネルマッチング（エッジ + グレースケール統合）
  onProgress?.({ stage: "アイコン検出中...", percent: 40 });
  const initialDetections = matchAllStatIcons(edgeMat, cv, scale);
  console.log("[OCR] initial detections:", initialDetections.length, initialDetections);

  // グリッド補完（2チャンネル）
  onProgress?.({ stage: "グリッド補完中...", percent: 50 });
  const iconSize = Math.round(80 * scale);
  const detections = fillGridGaps(
    initialDetections,
    edgeMat,
    cv,
    scale,
    iconSize,
  );
  console.log("[OCR] after grid fill:", detections.length, detections);

  edgeMat.delete();

  if (detections.length === 0) return [];

  // 行グルーピング
  const rows = groupIntoRows(detections, iconSize);
  console.log("[OCR] rows:", rows.length, rows);

  // 数値OCR
  onProgress?.({ stage: "数値読み取り中...", percent: 60 });
  const modules: ModuleInput[] = [];
  let uuidCounter = Date.now();

  for (let i = 0; i < rows.length; i++) {
    onProgress?.({
      stage: `数値読み取り中... (${i + 1}/${rows.length})`,
      percent: 60 + (i / rows.length) * 35,
    });

    const stats = await ocrNumbersForRow(canvas, rows[i]);
    if (stats.length > 0) {
      modules.push({
        uuid: uuidCounter++,
        quality: 4,
        stats,
      });
    }
  }

  onProgress?.({ stage: "完了", percent: 100 });
  return modules;
}
