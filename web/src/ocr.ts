import { STAT_ICONS, MODULE_ICONS } from "@shared/stats";
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
  grayMat: any; // グレースケール（スケール検出 + 分類用）
  edgeMat: any; // Cannyエッジ（分類用）
  classifyVariants: TemplateClassifyVariant[]; // 実画面寄りの背景合成版（局所分類用）
}

interface TemplateClassifyVariant {
  name: string;
  grayMat: any;
  edgeMat: any;
}

let statTemplates: TemplateInfo[] = [];

interface ModuleIconTemplateInfo {
  type: string;     // "attack" | "device" | "protect"
  rarity: number;   // 2-5
  grayMat: any;
  edgeMat: any;
  classifyVariants: TemplateClassifyVariant[];
}

let moduleIconTemplates: ModuleIconTemplateInfo[] = [];
let templatesLoaded = false;

const CLASSIFY_BACKGROUNDS = [
  { name: "selected", fill: "#CAD8D8" },
  { name: "idleDark", fill: "#1F2E33" },
  { name: "idleLight", fill: "#65777B" },
];

async function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`画像の読み込み失敗: ${src}`));
    img.src = src;
  });
}

function renderTemplateCanvas(
  img: HTMLImageElement,
  backgroundFill: string | null,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  if (backgroundFill) {
    ctx.fillStyle = backgroundFill;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0);
  return canvas;
}

function buildTemplateMats(
  canvas: HTMLCanvasElement,
  cv: any,
): { grayMat: any; edgeMat: any } {
  const mat = cv.imread(canvas);
  const gray = new cv.Mat();
  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
  cv.equalizeHist(gray, gray);

  const edge = new cv.Mat();
  cv.Canny(gray, edge, 50, 150);

  mat.delete();
  return { grayMat: gray, edgeMat: edge };
}

async function loadTemplates(): Promise<void> {
  if (templatesLoaded) return;
  const cv = (window as any).cv;

  for (const [partIdStr, iconFile] of Object.entries(STAT_ICONS)) {
    const partId = Number(partIdStr);
    const img = await loadImage(`/icons/${iconFile}`);

    const baseCanvas = renderTemplateCanvas(img, "#000000");
    const baseMats = buildTemplateMats(baseCanvas, cv);
    const classifyVariants = CLASSIFY_BACKGROUNDS.map((background) => {
      const variantCanvas = renderTemplateCanvas(img, background.fill);
      const mats = buildTemplateMats(variantCanvas, cv);
      return {
        name: background.name,
        grayMat: mats.grayMat,
        edgeMat: mats.edgeMat,
      };
    });

    statTemplates.push({
      partId,
      grayMat: baseMats.grayMat,
      edgeMat: baseMats.edgeMat,
      classifyVariants,
    });
  }

  for (const modIcon of MODULE_ICONS) {
    const img = await loadImage(`/icons/${modIcon.file}`);
    const baseCanvas = renderTemplateCanvas(img, "#000000");
    const baseMats = buildTemplateMats(baseCanvas, cv);
    const classifyVariants = CLASSIFY_BACKGROUNDS.map((background) => {
      const variantCanvas = renderTemplateCanvas(img, background.fill);
      const mats = buildTemplateMats(variantCanvas, cv);
      return {
        name: background.name,
        grayMat: mats.grayMat,
        edgeMat: mats.edgeMat,
      };
    });
    moduleIconTemplates.push({
      type: modIcon.type,
      rarity: modIcon.rarity,
      grayMat: baseMats.grayMat,
      edgeMat: baseMats.edgeMat,
      classifyVariants,
    });
  }

  templatesLoaded = true;
}

// --- pHash (Perceptual Hash) ---
// cv.dct() はCDN版OpenCV.jsに未収録のため、DCT-IIを純粋JSで実装
// 32x32行列の2D DCT: ~64K演算で1ms未満

function dct1d(input: number[]): number[] {
  const N = input.length;
  const output = new Array<number>(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((Math.PI / N) * (n + 0.5) * k);
    }
    output[k] = sum;
  }
  return output;
}

function computePHash(grayMat: any, cv: any): number[] {
  // 32x32にリサイズしてピクセルデータを取得
  const resized = new cv.Mat();
  cv.resize(grayMat, resized, new cv.Size(32, 32));

  const pixels: number[][] = [];
  for (let y = 0; y < 32; y++) {
    const row: number[] = [];
    for (let x = 0; x < 32; x++) {
      row.push(resized.ucharAt(y, x));
    }
    pixels.push(row);
  }
  resized.delete();

  // 2D DCT: 行方向 → 列方向
  const rowDct: number[][] = pixels.map((row) => dct1d(row));
  const colDct: number[][] = [];
  for (let y = 0; y < 32; y++) {
    colDct.push(new Array<number>(32));
  }
  for (let x = 0; x < 32; x++) {
    const col: number[] = [];
    for (let y = 0; y < 32; y++) {
      col.push(rowDct[y][x]);
    }
    const transformed = dct1d(col);
    for (let y = 0; y < 32; y++) {
      colDct[y][x] = transformed[y];
    }
  }

  // 左上8x8のDCT係数を取得（DC成分[0,0]を除外）
  const values: number[] = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (y === 0 && x === 0) continue;
      values.push(colDct[y][x]);
    }
  }

  // 中央値でハッシュ化（63bit）
  const sorted = [...values].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  return values.map((v) => (v > median ? 1 : 0));
}

function pHashSimilarity(h1: number[], h2: number[]): number {
  const len = Math.min(h1.length, h2.length);
  if (len === 0) return 0;
  let same = 0;
  for (let i = 0; i < len; i++) {
    if (h1[i] === h2[i]) same++;
  }
  return same / len;
}

// --- ヒストグラム比較 ---

function computeHistogram(grayMat: any, mask: any): Float64Array {
  const hist = new Float64Array(256);
  const data = grayMat.data;
  const maskData = mask.data;
  let total = 0;

  for (let i = 0; i < data.length; i++) {
    if (maskData[i] > 0) {
      hist[data[i]]++;
      total++;
    }
  }

  if (total > 0) {
    for (let i = 0; i < 256; i++) {
      hist[i] /= total;
    }
  }

  return hist;
}

function histCorrelation(h1: Float64Array, h2: Float64Array): number {
  let mean1 = 0;
  let mean2 = 0;
  for (let i = 0; i < 256; i++) {
    mean1 += h1[i];
    mean2 += h2[i];
  }
  mean1 /= 256;
  mean2 /= 256;

  let num = 0;
  let den1 = 0;
  let den2 = 0;
  for (let i = 0; i < 256; i++) {
    const d1 = h1[i] - mean1;
    const d2 = h2[i] - mean2;
    num += d1 * d2;
    den1 += d1 * d1;
    den2 += d2 * d2;
  }

  const den = Math.sqrt(den1 * den2);
  return den > 0 ? num / den : 0;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

// --- スケール検出（フォールバック + 半径推定用） ---

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

// --- テンプレートマッチング（フォールバック用） ---

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

// --- グリッド補完（フォールバック用） ---

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

  if (columns.length === 2) {
    const spacing = columns[1] - columns[0];
    const leftCandidate = Math.round(columns[0] - spacing);
    const rightCandidate = Math.round(columns[1] + spacing);
    if (leftCandidate >= 0) {
      columns.unshift(leftCandidate);
    } else if (rightCandidate + iconSize <= edgeImage.cols) {
      columns.push(rightCandidate);
    }
  }

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

// --- HoughCircles 位置検出 ---

interface Circle {
  cx: number;
  cy: number;
  r: number;
}

function detectCircles(
  blurredGray: any,
  cv: any,
  estimatedRadius: number,
): Circle[] {
  const circles = new cv.Mat();
  const lowRes = blurredGray.cols < 700 || estimatedRadius < 18;
  const minR = lowRes
    ? Math.max(8, Math.round(estimatedRadius * 0.8))
    : Math.max(5, Math.round(estimatedRadius * 0.5));
  const maxR = lowRes
    ? Math.round(estimatedRadius * 1.45)
    : Math.round(estimatedRadius * 1.8);
  const minDist = Math.round(estimatedRadius * (lowRes ? 1.4 : 1.5));
  const param2 = lowRes ? 18 : 22;

  cv.HoughCircles(
    blurredGray,
    circles,
    cv.HOUGH_GRADIENT,
    1, // dp
    minDist,
    100, // param1 (Canny上限閾値)
    param2, // param2 (累積閾値、低めで広く取得)
    minR,
    maxR,
  );

  const result: Circle[] = [];
  if (circles.cols > 0 && circles.data32F) {
    for (let i = 0; i < circles.cols; i++) {
      result.push({
        cx: circles.data32F[i * 3],
        cy: circles.data32F[i * 3 + 1],
        r: circles.data32F[i * 3 + 2],
      });
    }
  }
  circles.delete();
  return result;
}

// --- クラスタリング ---

interface ClusterCandidate {
  center: number;
  count: number;
}

function clusterValues(values: number[], threshold: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const existing = clusters.find((c) => {
      const center = c.reduce((sum, n) => sum + n, 0) / c.length;
      return Math.abs(center - v) < threshold;
    });
    if (existing) {
      existing.push(v);
    } else {
      clusters.push([v]);
    }
  }
  return clusters.map((c) => c.reduce((s, v) => s + v, 0) / c.length);
}

function clusterValuesWithCounts(
  values: number[],
  threshold: number,
): ClusterCandidate[] {
  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [];
  for (const v of sorted) {
    const existing = clusters.find((c) => {
      const center = c.reduce((sum, n) => sum + n, 0) / c.length;
      return Math.abs(center - v) < threshold;
    });
    if (existing) {
      existing.push(v);
    } else {
      clusters.push([v]);
    }
  }
  return clusters.map((c) => ({
    center: c.reduce((s, v) => s + v, 0) / c.length,
    count: c.length,
  }));
}

function scoreColumnWindow(
  window: ClusterCandidate[],
  medianR: number,
  preferRight: boolean,
): number {
  const support = window.reduce((sum, c) => sum + c.count, 0);
  if (window.length <= 1) return support * 100;

  const gaps: number[] = [];
  for (let i = 1; i < window.length; i++) {
    gaps.push(window[i].center - window[i - 1].center);
  }

  const medianGap = median(gaps);
  const irregularity = gaps.reduce((sum, gap) => sum + Math.abs(gap - medianGap), 0);
  const tooNarrow = gaps.some((gap) => gap < medianR * 2.2);
  const tooWide = gaps.some((gap) => gap > medianR * 7.5);
  const supportWeight = preferRight ? 70 : 100;
  const rightBias = preferRight ? window[0].center * 0.5 : 0;

  return (
    support * supportWeight -
    irregularity * 6 -
    (tooNarrow ? 60 : 0) -
    (tooWide ? 20 : 0) +
    rightBias
  );
}

// --- 行間隔フィルタ ---

function filterRowsBySpacing(rowYs: number[]): number[] {
  if (rowYs.length <= 4) return rowYs;

  let filtered = [...rowYs].sort((a, b) => a - b);
  let changed = true;

  // 並びの本体は等間隔に近い前提で、端の外れ行だけを落とす
  while (changed && filtered.length >= 6) {
    changed = false;

    const spacings: number[] = [];
    for (let i = 1; i < filtered.length; i++) {
      spacings.push(filtered[i] - filtered[i - 1]);
    }

    const medianSpacing = median(spacings);
    if (medianSpacing <= 0) break;

    const minAllowed = medianSpacing * 0.72;
    const maxAllowed = medianSpacing * 1.28;
    const firstSpacing = spacings[0];
    const lastSpacing = spacings[spacings.length - 1];

    if (firstSpacing < minAllowed || firstSpacing > maxAllowed) {
      filtered = filtered.slice(1);
      changed = true;
      continue;
    }

    if (lastSpacing < minAllowed || lastSpacing > maxAllowed) {
      filtered = filtered.slice(0, -1);
      changed = true;
    }
  }

  return filtered;
}

// --- グリッドスロット構築 ---

interface Slot {
  cx: number;
  cy: number;
  r: number;
  synthetic?: boolean;
}

function selectGlobalStatColumns(
  circles: Circle[],
  medianR: number,
  maxColsPerRow: number,
): number[] {
  const lowRes = medianR < 20;
  const xThreshold = medianR * (lowRes ? 2.0 : 1.2);
  const maxXRatio = lowRes ? 1.0 : 0.97;
  const maxX = circles.reduce((m, c) => Math.max(m, c.cx), 0) * maxXRatio;
  const candidates = circles.filter((c) => c.cx <= maxX);

  const xClusters = clusterValuesWithCounts(
    candidates.map((c) => c.cx),
    xThreshold,
  ).sort((a, b) => a.center - b.center);

  const minSupport = lowRes ? 1 : 2;
  const supported = xClusters.filter((c) => c.count >= minSupport);
  const usable = supported.length >= maxColsPerRow ? supported : xClusters;

  if (usable.length <= maxColsPerRow) {
    return usable.slice(0, maxColsPerRow).map((c) => c.center);
  }

  let bestWindow: ClusterCandidate[] = usable.slice(0, maxColsPerRow);
  let bestScore = -Infinity;
  for (let i = 0; i <= usable.length - maxColsPerRow; i++) {
    const window = usable.slice(i, i + maxColsPerRow);
    const score = scoreColumnWindow(window, medianR, !lowRes);
    if (score > bestScore) {
      bestScore = score;
      bestWindow = window;
    }
  }

  return bestWindow.map((c) => c.center);
}

function selectRowYsForColumns(
  circles: Circle[],
  globalCols: number[],
  medianR: number,
): number[] {
  if (globalCols.length === 0) return [];

  const rowThreshold = medianR * 1.2;
  const colThreshold = medianR * (medianR < 20 ? 2.0 : 1.4);
  const aligned = circles.filter((c) =>
    globalCols.some((colX) => Math.abs(c.cx - colX) <= colThreshold),
  );

  const rowClusters = clusterValuesWithCounts(
    aligned.map((c) => c.cy),
    rowThreshold,
  ).sort((a, b) => a.center - b.center);

  const minSupport = medianR < 20 ? 1 : Math.min(2, globalCols.length);
  const supported = rowClusters.filter((c) => c.count >= minSupport);
  const usable = supported.length > 0 ? supported : rowClusters;
  const filtered = filterRowsBySpacing(usable.map((c) => c.center));
  if (filtered.length < 2) return filtered;

  const allCenters = rowClusters.map((c) => c.center);
  const spacings: number[] = [];
  for (let i = 1; i < filtered.length; i++) {
    spacings.push(filtered[i] - filtered[i - 1]);
  }
  const medianSpacing = median(spacings);
  if (medianSpacing <= 0) return filtered;

  const extended = [...filtered];
  const addEdgeCandidate = (expectedY: number, atStart: boolean): void => {
    const candidate = allCenters
      .filter((y) =>
        atStart
          ? y < extended[0] - rowThreshold * 0.4
          : y > extended[extended.length - 1] + rowThreshold * 0.4,
      )
      .sort((a, b) => Math.abs(a - expectedY) - Math.abs(b - expectedY))[0];

    if (
      candidate !== undefined &&
      Math.abs(candidate - expectedY) <= rowThreshold * 1.2 &&
      !extended.some((y) => Math.abs(y - candidate) < rowThreshold * 0.5)
    ) {
      if (atStart) {
        extended.unshift(candidate);
      } else {
        extended.push(candidate);
      }
    }
  };

  addEdgeCandidate(extended[0] - medianSpacing, true);
  addEdgeCandidate(extended[extended.length - 1] + medianSpacing, false);
  return extended;
}

function buildGridSlots(
  circles: Circle[],
  maxColsPerRow: number = 3,
): Slot[] {
  if (circles.length === 0) return [];

  // 半径中央値
  const radii = circles.map((c) => c.r).sort((a, b) => a - b);
  const medianR = radii[Math.floor(radii.length / 2)];
  const lowRes = medianR < 20;

  // 半径中央値 ±30% でフィルタ
  const filtered = circles.filter(
    (c) => c.r >= medianR * 0.7 && c.r <= medianR * 1.3,
  );
  console.log(
    `[OCR] Hough: ${circles.length} candidates → ${filtered.length} after radius filter (medianR=${medianR.toFixed(1)})`,
  );

  if (filtered.length < 2) {
    return filtered.map((c) => ({ cx: c.cx, cy: c.cy, r: medianR }));
  }

  const rowThreshold = medianR * 1.2;
  const globalCols = selectGlobalStatColumns(
    filtered,
    medianR,
    maxColsPerRow,
  ).sort((a, b) => a - b);
  console.log(
    "[OCR] stat columns:",
    globalCols.map((x) => Math.round(x)),
  );

  const validRowYs = selectRowYsForColumns(filtered, globalCols, medianR);
  console.log(
    `[OCR] Hough rows: ${validRowYs.length}`,
    validRowYs.map((y) => Math.round(y)),
  );

  // 各行のX座標クラスタリング → グローバル列に最も近い候補だけ採用
  const slots: Slot[] = [];
  const colCounts: number[] = [];
  const colThreshold = medianR * (medianR < 20 ? 2.0 : 1.4);
  const minActualMatches = lowRes ? 1 : Math.min(2, globalCols.length);
  for (const rowY of validRowYs) {
    const rowCircles = filtered.filter(
      (c) =>
        Math.abs(c.cy - rowY) < rowThreshold &&
        globalCols.some((colX) => Math.abs(c.cx - colX) <= colThreshold),
    );
    const usedCols: Slot[] = [];
    const usedCircleIndices = new Set<number>();
    const matchedByCol: Array<Slot | null> = new Array(globalCols.length).fill(null);
    let actualMatches = 0;

    for (let colIndex = 0; colIndex < globalCols.length; colIndex++) {
      const colX = globalCols[colIndex];
      let bestIdx = -1;
      let bestDx = Infinity;
      for (let i = 0; i < rowCircles.length; i++) {
        if (usedCircleIndices.has(i)) continue;
        const dx = Math.abs(rowCircles[i].cx - colX);
        if (dx < bestDx) {
          bestDx = dx;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0 && bestDx <= medianR * (medianR < 20 ? 2.0 : 1.4)) {
        usedCircleIndices.add(bestIdx);
        actualMatches++;
        matchedByCol[colIndex] = {
          cx: rowCircles[bestIdx].cx,
          cy: rowY,
          r: rowCircles[bestIdx].r,
          synthetic: false,
        };
      }
    }

    const edgeRow =
      !lowRes &&
      (Math.abs(rowY - validRowYs[0]) < rowThreshold * 0.25 ||
        Math.abs(rowY - validRowYs[validRowYs.length - 1]) < rowThreshold * 0.25);
    const requiredMatches = edgeRow ? 1 : minActualMatches;
    if (actualMatches < requiredMatches) {
      continue;
    }

    for (let colIndex = 0; colIndex < globalCols.length; colIndex++) {
      const matched = matchedByCol[colIndex];
      if (matched) {
        usedCols.push(matched);
      } else if (medianR >= 20 && actualMatches > 0) {
        usedCols.push({
          cx: globalCols[colIndex],
          cy: rowY,
          r: medianR,
          synthetic: true,
        });
      }
    }

    colCounts.push(usedCols.length);
    for (const slot of usedCols) {
      slots.push(slot);
    }
  }

  console.log("[OCR] grid slots:", slots.length, "cols per row:", colCounts);
  return slots;
}

// --- 局所分類（背景バリエーション付き edge + gray） ---

interface ClassificationResult {
  detections: Detection[];
  attemptedSlots: number;
  lowConfidenceCount: number;
  avgMargin: number;
  lowRes: boolean;
}

function classifyAllSlots(
  grayEq: any,
  edgeMat: any,
  slots: Slot[],
  scale: number,
  cv: any,
): ClassificationResult {
  if (slots.length === 0) {
    return {
      detections: [],
      attemptedSlots: 0,
      lowConfidenceCount: 0,
      avgMargin: 0,
      lowRes: false,
    };
  }

  const medianR = median(slots.map((slot) => slot.r));
  const lowRes = grayEq.cols < 700 || medianR < 20;
  const iconSide = Math.max(16, Math.round(Math.max(medianR * 2, 80 * scale)));
  const basePad = lowRes ? 4 : 3;
  const symbolInset = Math.max(4, Math.round(iconSide * (lowRes ? 0.2 : 0.18)));
  const symbolSide = iconSide - symbolInset * 2;
  const scoreThreshold = lowRes ? 0.26 : 0.28;
  const marginThreshold = lowRes ? 0.015 : 0.02;
  const strongScoreThreshold = lowRes ? 0.34 : 0.36;

  if (symbolSide < 8) {
    return {
      detections: [],
      attemptedSlots: 0,
      lowConfidenceCount: 0,
      avgMargin: 0,
      lowRes,
    };
  }

  const symbolRect = new cv.Rect(symbolInset, symbolInset, symbolSide, symbolSide);

  // テンプレート前処理:
  // 1) 中央シンボルのエッジで形を比較
  // 2) 背景合成版テンプレで全体グレー比較
  const preppedTemplates = statTemplates.map((tmpl) => {
    return {
      partId: tmpl.partId,
      variants: tmpl.classifyVariants.map((variant) => {
        const grayIcon = new cv.Mat();
        cv.resize(variant.grayMat, grayIcon, new cv.Size(iconSide, iconSide));
        const edgeIcon = new cv.Mat();
        cv.resize(variant.edgeMat, edgeIcon, new cv.Size(iconSide, iconSide));

        const graySymbol = new cv.Mat();
        const edgeSymbol = new cv.Mat();
        grayIcon.roi(symbolRect).copyTo(graySymbol);
        edgeIcon.roi(symbolRect).copyTo(edgeSymbol);
        edgeIcon.delete();

        const edgeMask = new cv.Mat();
        cv.threshold(edgeSymbol, edgeMask, 1, 255, cv.THRESH_BINARY);
        const kernel = cv.Mat.ones(3, 3, cv.CV_8U);
        cv.dilate(edgeMask, edgeMask, kernel);
        kernel.delete();

        return {
          name: variant.name,
          grayIcon,
          graySymbol,
          edgeSymbol,
          edgeMask,
        };
      }),
    };
  });

  const detections: Detection[] = [];
  let attemptedSlots = 0;
  let lowConfidenceCount = 0;
  let marginSum = 0;

  for (const slot of slots) {
    const pad = slot.synthetic ? basePad + 3 : basePad;
    const roiX = Math.round(slot.cx - iconSide / 2 - pad);
    const roiY = Math.round(slot.cy - iconSide / 2 - pad);
    const roiSide = iconSide + pad * 2;

    // 境界チェック
    if (
      roiX < 0 ||
      roiY < 0 ||
      roiX + roiSide > grayEq.cols ||
      roiY + roiSide > grayEq.rows
    ) {
      continue;
    }

    attemptedSlots++;

    const localRect = new cv.Rect(roiX, roiY, roiSide, roiSide);
    const localGrayRoi = grayEq.roi(localRect);
    const localEdgeRoi = edgeMat.roi(localRect);

    let bestPartId = -1;
    let bestVariantName = "";
    let bestScore = -Infinity;
    let secondBestScore = -Infinity;

    for (const tmpl of preppedTemplates) {
      let partBestScore = -Infinity;
      let partBestVariantName = "";

      for (const variant of tmpl.variants) {
        const edgeResult = new cv.Mat();
        cv.matchTemplate(
          localEdgeRoi,
          variant.edgeSymbol,
          edgeResult,
          cv.TM_CCORR_NORMED,
          variant.edgeMask,
        );
        let edgeScore = cv.minMaxLoc(edgeResult).maxVal;
        if (isNaN(edgeScore)) edgeScore = 0;
        edgeResult.delete();

        const graySymbolResult = new cv.Mat();
        cv.matchTemplate(
          localGrayRoi,
          variant.graySymbol,
          graySymbolResult,
          cv.TM_CCORR_NORMED,
          variant.edgeMask,
        );
        let graySymbolScore = cv.minMaxLoc(graySymbolResult).maxVal;
        if (isNaN(graySymbolScore)) graySymbolScore = 0;
        graySymbolResult.delete();

        const grayIconResult = new cv.Mat();
        cv.matchTemplate(
          localGrayRoi,
          variant.grayIcon,
          grayIconResult,
          cv.TM_CCOEFF_NORMED,
        );
        let grayIconScore = cv.minMaxLoc(grayIconResult).maxVal;
        if (isNaN(grayIconScore)) grayIconScore = 0;
        grayIconResult.delete();

        const combined =
          edgeScore * 0.5 + graySymbolScore * 0.15 + grayIconScore * 0.35;

        if (combined > partBestScore) {
          partBestScore = combined;
          partBestVariantName = variant.name;
        }
      }

      if (partBestScore > bestScore) {
        secondBestScore = bestScore;
        bestScore = partBestScore;
        bestPartId = tmpl.partId;
        bestVariantName = partBestVariantName;
      } else if (partBestScore > secondBestScore) {
        secondBestScore = partBestScore;
      }
    }

    localGrayRoi.delete();
    localEdgeRoi.delete();

    const margin = bestScore - secondBestScore;
    marginSum += margin;
    console.log(
      `[OCR] slot (${Math.round(slot.cx)}, ${Math.round(slot.cy)}): ` +
        `partId=${bestPartId} bg=${bestVariantName} score=${bestScore.toFixed(3)} margin=${margin.toFixed(3)}`,
    );

    const confident =
      bestPartId >= 0 &&
      (bestScore >= strongScoreThreshold ||
        (bestScore >= scoreThreshold && margin >= marginThreshold));

    if (!confident) {
      lowConfidenceCount++;
    }

    if (confident) {
      const side = Math.round(2 * slot.r);
      detections.push({
        partId: bestPartId,
        x: Math.round(slot.cx - slot.r),
        y: Math.round(slot.cy - slot.r),
        w: side,
        h: side,
        score: bestScore,
      });
    }
  }

  // テンプレート前処理のクリーンアップ
  for (const tmpl of preppedTemplates) {
    for (const variant of tmpl.variants) {
      variant.grayIcon.delete();
      variant.graySymbol.delete();
      variant.edgeSymbol.delete();
      variant.edgeMask.delete();
    }
  }

  return {
    detections,
    attemptedSlots,
    lowConfidenceCount,
    avgMargin: attemptedSlots > 0 ? marginSum / attemptedSlots : 0,
    lowRes,
  };
}

function shouldFallbackToTemplateMatching(
  slots: Slot[],
  result: ClassificationResult,
): boolean {
  if (slots.length === 0 || result.attemptedSlots === 0) return true;
  if (result.detections.length === 0) return true;

  const acceptedRatio = result.detections.length / result.attemptedSlots;
  const lowConfidenceRatio =
    result.attemptedSlots > 0
      ? result.lowConfidenceCount / result.attemptedSlots
      : 1;
  const partIdCounts = new Map<number, number>();
  for (const detection of result.detections) {
    partIdCounts.set(detection.partId, (partIdCounts.get(detection.partId) ?? 0) + 1);
  }
  const topTwoCoverage =
    [...partIdCounts.values()]
      .sort((a, b) => b - a)
      .slice(0, 2)
      .reduce((sum, count) => sum + count, 0) / Math.max(result.detections.length, 1);

  if (!result.lowRes) {
    if (acceptedRatio < 0.65) return true;
    if (lowConfidenceRatio > 0.45 && result.avgMargin < 0.025) return true;
    if (result.detections.length >= 12 && topTwoCoverage > 0.8) return true;
  } else {
    if (acceptedRatio < 0.35) return true;
    if (lowConfidenceRatio > 0.75 && result.avgMargin < 0.008) return true;
  }

  return false;
}

// --- 数値OCR ---

async function ocrNumbersForRow(
  sourceCanvas: HTMLCanvasElement,
  row: ModuleRow,
): Promise<StatEntry[]> {
  const { createWorker } = await import("tesseract.js");

  const stats: StatEntry[] = [];
  const padding = 3;
  const verticalPad = 2;

  interface OcrCrop {
    cropX: number;
    cropY: number;
    cropW: number;
    cropH: number;
  }

  interface OcrDebugInfo {
    hadPlus: boolean;
    rawText: string;
    normalized: string;
    matchedText: string;
    cropIndex: number;
    mode: "binary-invert" | "binary-normal" | "gray" | "adaptive" | "color-distance";
    threshold: number | null;
    upscale: number;
  }

  interface OcrResult extends StatEntry {
    _ocrDebug?: OcrDebugInfo;
  }

  interface ExtractedValue {
    value: number;
    hadPlus: boolean;
    rawText: string;
    normalized: string;
    matchedText: string;
  }

  const extractValue = (text: string): ExtractedValue => {
    const normalized = text
      .trim()
      .replace(/\s/g, "")
      .replace(/[Il|]/g, "1")
      .replace(/[Oo]/g, "0")
      .replace(/S/g, "5");
    const match = normalized.match(/\+?(\d{1,2})/);
    if (!match) {
      return {
        value: 0,
        hadPlus: normalized.includes("+"),
        rawText: text,
        normalized,
        matchedText: "",
      };
    }
    const val = parseInt(match[1], 10);
    return {
      value: val >= 1 && val <= 20 ? val : 0,
      hadPlus: match[0].startsWith("+"),
      rawText: text,
      normalized,
      matchedText: match[0],
    };
  };

  const buildOcrCanvas = (
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
    threshold: number | null,
    upscale: number,
    mode: "binary-invert" | "binary-normal" | "gray" | "adaptive" | "color-distance",
  ): HTMLCanvasElement => {
    const numCanvas = document.createElement("canvas");
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

    const imageData = ctx.getImageData(0, 0, numCanvas.width, numCanvas.height);
    const w = numCanvas.width;
    const h = numCanvas.height;

    if (mode === "adaptive") {
      // 適応的二値化: ローカル平均との差分で文字を抽出
      // 背景の明るさが変化しても文字を正確に分離できる
      const brightness = new Float32Array(w * h);
      for (let i = 0; i < imageData.data.length; i += 4) {
        brightness[i / 4] =
          imageData.data[i] * 0.299 +
          imageData.data[i + 1] * 0.587 +
          imageData.data[i + 2] * 0.114;
      }

      // Integral image で高速にローカル平均を計算
      const integral = new Float64Array((w + 1) * (h + 1));
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          integral[(y + 1) * (w + 1) + (x + 1)] =
            brightness[y * w + x] +
            integral[y * (w + 1) + (x + 1)] +
            integral[(y + 1) * (w + 1) + x] -
            integral[y * (w + 1) + x];
        }
      }

      const windowSize = Math.max(15, (Math.round(w / 5) | 1));
      const half = Math.floor(windowSize / 2);
      const C = threshold ?? 10;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const x0 = Math.max(0, x - half);
          const y0 = Math.max(0, y - half);
          const x1 = Math.min(w, x + half + 1);
          const y1 = Math.min(h, y + half + 1);
          const area = (x1 - x0) * (y1 - y0);
          const sum =
            integral[y1 * (w + 1) + x1] -
            integral[y0 * (w + 1) + x1] -
            integral[y1 * (w + 1) + x0] +
            integral[y0 * (w + 1) + x0];
          const localMean = sum / area;
          // 文字はローカル平均よりC以上明るい → 黒（文字）、それ以外 → 白（背景）
          const val = brightness[y * w + x] > localMean + C ? 0 : 255;
          const idx = (y * w + x) * 4;
          imageData.data[idx] = val;
          imageData.data[idx + 1] = val;
          imageData.data[idx + 2] = val;
          imageData.data[idx + 3] = 255;
        }
      }
    } else if (mode === "color-distance") {
      // 既知の文字色（#98ADB2～#99A8AB）との色距離で二値化
      // 背景の明るさに関係なく文字色に近いピクセルだけを抽出
      const refR = 153, refG = 171, refB = 175;
      const maxDist = threshold ?? 50;

      for (let i = 0; i < imageData.data.length; i += 4) {
        const dr = imageData.data[i] - refR;
        const dg = imageData.data[i + 1] - refG;
        const db = imageData.data[i + 2] - refB;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        const val = dist <= maxDist ? 0 : 255;
        imageData.data[i] = val;
        imageData.data[i + 1] = val;
        imageData.data[i + 2] = val;
        imageData.data[i + 3] = 255;
      }
    } else {
      for (let i = 0; i < imageData.data.length; i += 4) {
        const r = imageData.data[i];
        const g = imageData.data[i + 1];
        const b = imageData.data[i + 2];
        const brightness = r * 0.299 + g * 0.587 + b * 0.114;
        let val = brightness;
        if (mode !== "gray" && threshold !== null) {
          if (mode === "binary-invert") {
            val = brightness > threshold ? 0 : 255;
          } else {
            val = brightness > threshold ? 255 : 0;
          }
        }
        imageData.data[i] = val;
        imageData.data[i + 1] = val;
        imageData.data[i + 2] = val;
        imageData.data[i + 3] = 255;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    return numCanvas;
  };

  for (const stat of row.stats) {
    const cropVariants: OcrCrop[] = [
      {
        cropX: stat.x + stat.w + padding,
        cropY: Math.max(0, stat.y - verticalPad),
        cropW: Math.round(stat.w * 1.8),
        cropH: Math.min(
          sourceCanvas.height - Math.max(0, stat.y - verticalPad),
          stat.h + verticalPad * 2,
        ),
      },
      {
        cropX: Math.max(0, stat.x + stat.w - 2),
        cropY: Math.max(0, stat.y - verticalPad - 1),
        cropW: Math.round(stat.w * 2.0),
        cropH: Math.min(
          sourceCanvas.height - Math.max(0, stat.y - verticalPad - 1),
          stat.h + verticalPad * 2 + 2,
        ),
      },
      {
        cropX: Math.max(0, stat.x + Math.round(stat.w * 0.9)),
        cropY: Math.max(0, stat.y - verticalPad - 2),
        cropW: Math.round(stat.w * 2.2),
        cropH: Math.min(
          sourceCanvas.height - Math.max(0, stat.y - verticalPad - 2),
          stat.h + verticalPad * 2 + 4,
        ),
      },
    ].filter(
      (crop, index, all) =>
        crop.cropW > 0 &&
        crop.cropH > 0 &&
        crop.cropX + crop.cropW <= sourceCanvas.width &&
        crop.cropY + crop.cropH <= sourceCanvas.height &&
        all.findIndex(
          (other) =>
            other.cropX === crop.cropX &&
            other.cropY === crop.cropY &&
            other.cropW === crop.cropW &&
            other.cropH === crop.cropH,
        ) === index,
    );

    if (cropVariants.length === 0) continue;

    stats.push({
      part_id: stat.partId,
      value: 0,
      _ocrCrops: cropVariants,
    } as any as OcrResult);
  }

  if (stats.length === 0) return [];

  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_char_whitelist: "+0123456789",
    tessedit_pageseg_mode: "7" as any,
  });

  for (const stat of stats) {
    const cropVariants = (stat as any)._ocrCrops as OcrCrop[];
    try {
      const attempts = [
        { threshold: 10,  upscale: 4, mode: "adaptive" as const },
        { threshold: 45,  upscale: 4, mode: "color-distance" as const },
        { threshold: 120, upscale: 4, mode: "binary-invert" as const },
        { threshold: 150, upscale: 4, mode: "binary-invert" as const },
        { threshold: 15,  upscale: 5, mode: "adaptive" as const },
        { threshold: 60,  upscale: 5, mode: "color-distance" as const },
        { threshold: 100, upscale: 5, mode: "binary-invert" as const },
        { threshold: 120, upscale: 4, mode: "binary-normal" as const },
        { threshold: 145, upscale: 5, mode: "binary-normal" as const },
        { threshold: null, upscale: 5, mode: "gray" as const },
      ];

      for (let cropIndex = 0; cropIndex < cropVariants.length; cropIndex++) {
        const crop = cropVariants[cropIndex];
        for (const attempt of attempts) {
          const canvas = buildOcrCanvas(
            crop.cropX,
            crop.cropY,
            crop.cropW,
            crop.cropH,
            attempt.threshold,
            attempt.upscale,
            attempt.mode,
          );
          const { data } = await worker.recognize(canvas);
          canvas.remove();
          const extracted = extractValue(data.text);
          if (extracted.value > 0) {
            stat.value = extracted.value;
            (stat as OcrResult)._ocrDebug = {
              hadPlus: extracted.hadPlus,
              rawText: extracted.rawText,
              normalized: extracted.normalized,
              matchedText: extracted.matchedText,
              cropIndex,
              mode: attempt.mode,
              threshold: attempt.threshold,
              upscale: attempt.upscale,
            };
            console.log(
              `[OCR] value OCR hit: partId=${stat.part_id} value=${extracted.value} ` +
                `plus=${extracted.hadPlus} raw="${extracted.rawText.replace(/\s+/g, " ").trim()}" ` +
                `normalized="${extracted.normalized}" match="${extracted.matchedText}" ` +
                `crop=${cropIndex + 1} mode=${attempt.mode} threshold=${attempt.threshold ?? "gray"} ` +
                `upscale=${attempt.upscale}`,
            );
            break;
          }
        }
        if (stat.value > 0) break;
      }
    } catch {
      // OCR失敗
    }
    if (stat.value === 0) {
      console.log(`[OCR] value OCR failed: partId=${stat.part_id}`);
    }
    delete (stat as any)._ocrCrops;
  }

  await worker.terminate();
  return stats.filter((s) => s.value > 0);
}

// --- メイン処理 ---

export interface OcrProgress {
  stage: string;
  percent: number;
}

// --- モジュールアイコン分類 ---

interface ModuleIconMatch {
  type: string;
  rarity: number;
  configId: number;
  score: number;
}

const TYPE_DIGIT_MAP: Record<string, number> = { attack: 1, device: 2, protect: 3 };

function buildConfigId(typeName: string, rarity: number): number {
  const typeDigit = TYPE_DIGIT_MAP[typeName] ?? 0;
  const rareSub = rarity - 1; // rarity 2→1, 3→2, 4→3, 5→4
  return (55000 + typeDigit) * 100 + rareSub;
}

function classifyModuleIconForRow(
  grayEq: any,
  edgeMat: any,
  row: ModuleRow,
  statScale: number,
  cv: any,
): ModuleIconMatch | null {
  if (moduleIconTemplates.length === 0 || row.stats.length === 0) return null;

  // ステータスアイコンの左端を基準に検索領域を決定
  const leftStat = row.stats.reduce((min, s) => (s.x < min.x ? s : min), row.stats[0]);
  const statIconSize = leftStat.w;

  // モジュールアイコンの想定サイズ（ステータスアイコンの1.2〜2.0倍）
  const modSizeEstimate = Math.round(statIconSize * 1.6);
  const searchMargin = Math.round(statIconSize * 0.5);

  // 検索領域: ステータスアイコンの左側
  const roiX = Math.max(0, leftStat.x - modSizeEstimate * 2 - searchMargin);
  const roiY = Math.max(0, leftStat.y - Math.round(modSizeEstimate * 0.5));
  const roiW = Math.min(leftStat.x - roiX, grayEq.cols - roiX);
  const roiH = Math.min(modSizeEstimate * 2, grayEq.rows - roiY);

  if (roiW < modSizeEstimate * 0.5 || roiH < modSizeEstimate * 0.5) return null;

  const roiRect = new cv.Rect(roiX, roiY, roiW, roiH);
  const roiGray = grayEq.roi(roiRect);
  const roiEdge = edgeMat.roi(roiRect);

  let bestMatch: ModuleIconMatch | null = null;

  // モジュールアイコン(256px)をスクリーンショットのサイズに合わせてスケール
  // stat icon: 80px * statScale → screenshot size
  // module icon: 256px * modScale → screenshot size (≈ statIconSize * 1.2~2.0)
  const baseModScale = (statIconSize * 1.6) / 256;
  const scaleRange = [0.7, 0.85, 1.0, 1.15, 1.3];

  for (const scaleMul of scaleRange) {
    const modScale = baseModScale * scaleMul;

    for (const tmpl of moduleIconTemplates) {
      const tw = Math.round(tmpl.edgeMat.cols * modScale);
      const th = Math.round(tmpl.edgeMat.rows * modScale);
      if (tw < 10 || th < 10 || tw >= roiW || th >= roiH) continue;

      // エッジマッチング
      const resizedEdge = new cv.Mat();
      cv.resize(tmpl.edgeMat, resizedEdge, new cv.Size(tw, th));
      const edgeResult = new cv.Mat();
      cv.matchTemplate(roiEdge, resizedEdge, edgeResult, cv.TM_CCOEFF_NORMED);
      const edgeScore = cv.minMaxLoc(edgeResult).maxVal;
      resizedEdge.delete();
      edgeResult.delete();

      // グレーマッチング (best variant)
      let bestGrayScore = 0;
      for (const variant of tmpl.classifyVariants) {
        const resizedGray = new cv.Mat();
        cv.resize(variant.grayMat, resizedGray, new cv.Size(tw, th));
        const grayResult = new cv.Mat();
        cv.matchTemplate(roiGray, resizedGray, grayResult, cv.TM_CCOEFF_NORMED);
        const gs = cv.minMaxLoc(grayResult).maxVal;
        if (gs > bestGrayScore) bestGrayScore = gs;
        resizedGray.delete();
        grayResult.delete();
      }

      const combined = edgeScore * 0.5 + bestGrayScore * 0.5;

      if (!bestMatch || combined > bestMatch.score) {
        bestMatch = {
          type: tmpl.type,
          rarity: tmpl.rarity,
          configId: buildConfigId(tmpl.type, tmpl.rarity),
          score: combined,
        };
      }
    }
  }

  roiGray.delete();
  roiEdge.delete();

  // 信頼度が低すぎる場合はnull
  if (bestMatch && bestMatch.score < 0.2) {
    console.log(`[OCR] module icon: score too low (${bestMatch.score.toFixed(3)}), skipping`);
    return null;
  }

  if (bestMatch) {
    console.log(
      `[OCR] module icon: type=${bestMatch.type} rarity=${bestMatch.rarity} ` +
        `score=${bestMatch.score.toFixed(3)} configId=${bestMatch.configId}`,
    );
  }

  return bestMatch;
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

  // スケール検出（フォールバック + 半径推定用）
  onProgress?.({ stage: "スケール検出中...", percent: 20 });
  const scale = detectScale(gray, cv);
  const estimatedRadius = Math.round(40 * scale);
  const lowResInput = canvas.width < 700 || estimatedRadius < 18;
  console.log(
    "[OCR] scale:",
    scale,
    "estimatedRadius:",
    estimatedRadius,
    "lowResInput:",
    lowResInput,
  );

  // HoughCircles用にmedianBlur適用
  const blurred = new cv.Mat();
  cv.medianBlur(gray, blurred, 5);
  gray.delete();

  // HoughCirclesで円候補を検出
  onProgress?.({ stage: "アイコン位置検出中...", percent: 30 });
  const circles = detectCircles(blurred, cv, estimatedRadius);
  blurred.delete();
  console.log("[OCR] HoughCircles candidates:", circles.length);

  let detections: Detection[];

  if (!lowResInput && circles.length >= 3) {
    // グリッドスロット構築
    onProgress?.({ stage: "グリッド解析中...", percent: 40 });
    const slots = buildGridSlots(circles, 3);

    if (slots.length > 0) {
      // 局所分類（edge + gray + hist + pHash）
      onProgress?.({ stage: "アイコン分類中...", percent: 50 });
      const classified = classifyAllSlots(grayEq, edgeMat, slots, scale, cv);
      console.log(
        "[OCR] Hough+classify detections:",
        classified.detections.length,
        `attempted=${classified.attemptedSlots}`,
        `avgMargin=${classified.avgMargin.toFixed(3)}`,
        `lowConfidence=${classified.lowConfidenceCount}`,
      );

      if (shouldFallbackToTemplateMatching(slots, classified)) {
        console.log("[OCR] classification weak, falling back to template matching");
        const fallback = matchAllStatIcons(edgeMat, cv, scale);
        const fallbackIconSize = Math.round(80 * scale);
        const fallbackFilled = fillGridGaps(
          fallback,
          edgeMat,
          cv,
          scale,
          fallbackIconSize,
        );
        detections =
          fallbackFilled.length >= classified.detections.length
            ? fallbackFilled
            : classified.detections;
      } else {
        detections = classified.detections;
      }
    } else {
      // スロット構築失敗 → フォールバック
      console.log("[OCR] grid slot construction failed, falling back");
      detections = matchAllStatIcons(edgeMat, cv, scale);
      const iconSize = Math.round(80 * scale);
      detections = fillGridGaps(detections, edgeMat, cv, scale, iconSize);
    }
  } else {
    // HoughCircles候補不足 → フォールバック（既存テンプレートマッチング方式）
    console.log(
      "[OCR] skipping Hough path, falling back to template matching",
      `lowRes=${lowResInput}`,
      `circles=${circles.length}`,
    );
    onProgress?.({ stage: "アイコン検出中（フォールバック）...", percent: 40 });
    detections = matchAllStatIcons(edgeMat, cv, scale);
    const iconSize = Math.round(80 * scale);
    detections = fillGridGaps(detections, edgeMat, cv, scale, iconSize);
    console.log("[OCR] fallback detections:", detections.length);
  }

  if (detections.length === 0) {
    grayEq.delete();
    edgeMat.delete();
    return [];
  }

  // 行グルーピング
  const iconSize = detections[0]?.w || Math.round(80 * scale);
  const rows = groupIntoRows(detections, iconSize);
  console.log(
    "[OCR] rows:",
    rows.length,
    rows.map((r) => r.stats.length),
  );

  // モジュールアイコン分類（各行の左側を検索）
  onProgress?.({ stage: "モジュールアイコン検出中...", percent: 55 });
  const moduleIcons: (ModuleIconMatch | null)[] = [];
  for (const row of rows) {
    moduleIcons.push(classifyModuleIconForRow(grayEq, edgeMat, row, scale, cv));
  }

  grayEq.delete();
  edgeMat.delete();

  // 数値OCR
  onProgress?.({ stage: "数値読み取り中...", percent: 60 });
  const modules: ModuleInput[] = [];
  let uuidCounter = Date.now();

  for (let i = 0; i < rows.length; i++) {
    onProgress?.({
      stage: `数値読み取り中... (${i + 1}/${rows.length})`,
      percent: 60 + (i / rows.length) * 35,
    });

    const stats = await ocrNumbersForRow(canvas, rows[i]) as Array<
      StatEntry & {
        _ocrDebug?: {
          hadPlus: boolean;
          rawText: string;
          normalized: string;
          matchedText: string;
        };
      }
    >;
    console.log(
      `[OCR] row ${i + 1}: icons=${rows[i].stats.length} ocrStats=${stats.length}`,
      stats.map(
        (s) =>
          `${s.part_id}:${s.value}${s._ocrDebug?.hadPlus ? "(+)" : "(-)"}`,
      ),
    );
    if (stats.length > 0) {
      const modIcon = moduleIcons[i];
      modules.push({
        uuid: uuidCounter++,
        config_id: modIcon?.configId ?? null,
        quality: modIcon?.rarity ?? null,
        stats: stats.map((s) => ({ part_id: s.part_id, value: s.value })),
      });
    }
  }

  onProgress?.({ stage: "完了", percent: 100 });
  return modules;
}
