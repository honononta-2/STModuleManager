import { STAT_ICONS, MODULE_ICONS } from "@shared/stats";
import type { ModuleInput, StatEntry } from "@shared/types";

// --- 詳細設定モードオプション ---

export interface OcrCustomOptions {
  platform: "mobile" | "pc";
  region?: { x: number; y: number; width: number; height: number };
  rarities?: number[];   // e.g. [3, 4, 5]
  typeNames?: string[];  // e.g. ["attack", "device", "protect"]
}

// 極系ステータス (partId 2xxx) — 真ん中・右の列では出現しない
const EXTREME_STAT_PIDS = new Set([2104, 2105, 2204, 2205, 2304, 2404, 2405, 2406]);

// --- OpenCV.js 動的ロード ---

let cvReady: Promise<void> | null = null;

function loadOpenCV(): Promise<void> {
  if (cvReady) return cvReady;
  const p = new Promise<void>((resolve, reject) => {
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
  cvReady = p.catch((err) => { cvReady = null; throw err; });
  return cvReady;
}

// --- テンプレート管理 ---

interface TemplateInfo {
  partId: number;
  grayMat: any; // グレースケール（スケール検出 + 分類用）
  edgeMat: any; // Cannyエッジ（分類用）
  classifyVariants: TemplateClassifyVariant[]; // 実画面寄りの背景合成版（局所分類用）
  colorVariants: { name: string; colorMat: any }[]; // カラー版（BGR, テンプレート列+カラーマッチング用）
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
  colorVariants: { name: string; colorMat: any }[]; // カラー版（BGR）
}

let moduleIconTemplates: ModuleIconTemplateInfo[] = [];

interface UserModuleOcrTemplateInfo {
  type: string;
  rarity: number;
  colorMat: any;
  avgHash: number[];
  grayEqMat: any; // グレースケール+equalizeHist版（キャッシュ）
}

let userModuleOcrTemplates: UserModuleOcrTemplateInfo[] = [];
let templatesLoaded = false;

const CLASSIFY_BACKGROUNDS = [
  { name: "selected", fill: "#C8D8D8" },
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
  backgroundFill: string | HTMLImageElement | null,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  if (backgroundFill instanceof HTMLImageElement) {
    ctx.drawImage(backgroundFill, 0, 0, img.width, img.height);
  } else if (backgroundFill) {
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

function buildColorMat(canvas: HTMLCanvasElement, cv: any): any {
  return cv.imread(canvas);
}

async function loadTemplates(): Promise<void> {
  if (templatesLoaded) return;
  const cv = (window as any).cv;

  // リトライ時の重複防止: 既存データを解放してからリセット
  for (const t of statTemplates) {
    t.grayMat.delete(); t.edgeMat.delete();
    for (const v of t.classifyVariants) { v.grayMat.delete(); v.edgeMat.delete(); }
    for (const v of t.colorVariants) { v.colorMat.delete(); }
  }
  for (const t of moduleIconTemplates) {
    t.grayMat.delete(); t.edgeMat.delete();
    for (const v of t.classifyVariants) { v.grayMat.delete(); v.edgeMat.delete(); }
    for (const v of t.colorVariants) { v.colorMat.delete(); }
  }
  for (const t of userModuleOcrTemplates) { t.colorMat.delete(); t.grayEqMat.delete(); }
  statTemplates = [];
  moduleIconTemplates = [];
  userModuleOcrTemplates = [];

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

    // カラーバリアント（テンプレート列+カラーマッチング用）
    const colorVariants = CLASSIFY_BACKGROUNDS.map((background) => {
      const variantCanvas = renderTemplateCanvas(img, background.fill);
      const colorMat = buildColorMat(variantCanvas, cv);
      return { name: background.name, colorMat };
    });

    statTemplates.push({
      partId,
      grayMat: baseMats.grayMat,
      edgeMat: baseMats.edgeMat,
      classifyVariants,
      colorVariants,
    });
  }

  const rarityBgImages: Record<number, HTMLImageElement> = {};
  for (const r of [2, 3, 4]) {
    rarityBgImages[r] = await loadImage(`/icons/rarity${r}.png`);
  }

  for (const modIcon of MODULE_ICONS) {
    // rarity5もカラーマッチングで区別可能なため含める
    const img = await loadImage(`/icons/${modIcon.file}`);
    const bgRarity = Math.min(modIcon.rarity, 4);
    const bgImg = rarityBgImages[bgRarity];

    const baseCanvas = renderTemplateCanvas(img, bgImg);
    const baseMats = buildTemplateMats(baseCanvas, cv);

    const modClassifyVariants = CLASSIFY_BACKGROUNDS.map((background) => {
      const variantCanvas = renderTemplateCanvas(img, background.fill);
      const mats = buildTemplateMats(variantCanvas, cv);
      return {
        name: background.name,
        grayMat: mats.grayMat,
        edgeMat: mats.edgeMat,
      };
    });

    // カラーバリアント（モジュールアイコンカラーマッチング用）
    const modColorVariants = CLASSIFY_BACKGROUNDS.map((background) => {
      const variantCanvas = renderTemplateCanvas(img, background.fill);
      const colorMat = buildColorMat(variantCanvas, cv);
      return { name: background.name, colorMat };
    });
    // レアリティ背景合成版もカラーに追加
    const bgCanvas = renderTemplateCanvas(img, bgImg);
    const bgColorMat = buildColorMat(bgCanvas, cv);
    modColorVariants.push({ name: "rarityBg", colorMat: bgColorMat });

    moduleIconTemplates.push({
      type: modIcon.type,
      rarity: modIcon.rarity,
      grayMat: baseMats.grayMat,
      edgeMat: baseMats.edgeMat,
      classifyVariants: modClassifyVariants,
      colorVariants: modColorVariants,
    });
  }

  for (const modIcon of MODULE_ICONS) {
    if (modIcon.rarity === 5) continue; // 金Bスキップ
    try {
      const img = await loadImage(`/icons/OCR_${modIcon.type}${modIcon.rarity}.png`);
      const colorCanvas = renderTemplateCanvas(img, null);
      const colorMat = buildColorMat(colorCanvas, cv);
      // グレースケール+equalizeHist版をキャッシュ（スライディング検出で毎回変換する無駄を排除）
      const grayTmpl = new cv.Mat();
      cv.cvtColor(colorMat, grayTmpl, cv.COLOR_RGBA2GRAY);
      const grayEqTmpl = new cv.Mat();
      cv.equalizeHist(grayTmpl, grayEqTmpl);
      grayTmpl.delete();

      userModuleOcrTemplates.push({
        type: modIcon.type,
        rarity: modIcon.rarity,
        colorMat,
        avgHash: computeAverageHash(colorMat, cv),
        grayEqMat: grayEqTmpl,
      });
    } catch {
      // ユーザー提供のOCRテンプレートは任意
    }
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

// --- CLAHE (Contrast Limited Adaptive Histogram Equalization) ---
// opencv.js には createCLAHE がないため手動実装。
// バイリニア補間付きタイルベース。Python版CLAHEと同等精度を確認済み。

function applyCLAHE(
  gray: any,
  cv: any,
  clipLimit: number = 2.0,
  tileGridSize: number = 8,
): any {
  const h = gray.rows;
  const w = gray.cols;
  const result = new cv.Mat(h, w, cv.CV_8UC1);

  const tilesY = Math.ceil(h / tileGridSize);
  const tilesX = Math.ceil(w / tileGridSize);

  // 各タイルのCDF（累積分布関数）を計算
  const cdfs: Float64Array[][] = [];
  for (let ty = 0; ty < tilesY; ty++) {
    cdfs[ty] = [];
    for (let tx = 0; tx < tilesX; tx++) {
      const y0 = Math.round((ty * h) / tilesY);
      const y1 = Math.round(((ty + 1) * h) / tilesY);
      const x0 = Math.round((tx * w) / tilesX);
      const x1 = Math.round(((tx + 1) * w) / tilesX);

      const hist = new Float64Array(256);
      const pixels = (y1 - y0) * (x1 - x0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          hist[gray.data[y * w + x]]++;
        }
      }

      // クリッピング: 上限を超えた分を均等に再分配
      const limit = Math.max(1, Math.round((clipLimit * pixels) / 256));
      let excess = 0;
      for (let i = 0; i < 256; i++) {
        if (hist[i] > limit) {
          excess += hist[i] - limit;
          hist[i] = limit;
        }
      }
      const bonus = Math.floor(excess / 256);
      for (let i = 0; i < 256; i++) hist[i] += bonus;

      // CDF計算 + 正規化
      const cdf = new Float64Array(256);
      cdf[0] = hist[0];
      for (let i = 1; i < 256; i++) cdf[i] = cdf[i - 1] + hist[i];
      const cdfMin = cdf.find((v) => v > 0) ?? 0;
      const denom = Math.max(1, pixels - cdfMin);
      for (let i = 0; i < 256; i++) {
        cdf[i] = Math.round(((cdf[i] - cdfMin) / denom) * 255);
        cdf[i] = Math.max(0, Math.min(255, cdf[i]));
      }
      cdfs[ty][tx] = cdf;
    }
  }

  // 隣接タイル間のバイリニア補間で滑らかな結果を生成
  const tileH = h / tilesY;
  const tileW = w / tilesX;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pixel = gray.data[y * w + x];
      const fy = (y + 0.5) / tileH - 0.5;
      const fx = (x + 0.5) / tileW - 0.5;
      const ty0 = Math.max(0, Math.floor(fy));
      const ty1 = Math.min(tilesY - 1, ty0 + 1);
      const tx0 = Math.max(0, Math.floor(fx));
      const tx1 = Math.min(tilesX - 1, tx0 + 1);
      const wy = fy - ty0;
      const wx = fx - tx0;

      const val =
        cdfs[ty0][tx0][pixel] * (1 - wy) * (1 - wx) +
        cdfs[ty0][tx1][pixel] * (1 - wy) * wx +
        cdfs[ty1][tx0][pixel] * wy * (1 - wx) +
        cdfs[ty1][tx1][pixel] * wy * wx;

      result.data[y * w + x] = Math.round(Math.max(0, Math.min(255, val)));
    }
  }

  return result;
}

// --- スケール検出（半径推定 + スケール基準用） ---

function detectScale(grayImage: any, cv: any): number {
  const refs = statTemplates.slice(0, 5);
  if (refs.length === 0) return 0.5;

  let bestScale = 0.5;
  let bestScore = -1;

  const resized = new cv.Mat();
  const result = new cv.Mat();

  const testScaleOn = (image: any, scale: number, sizeMul: number) => {
    let maxScore = 0;
    for (const ref of refs) {
      const w = Math.round(ref.grayMat.cols * scale * sizeMul);
      const h = Math.round(ref.grayMat.rows * scale * sizeMul);
      if (w < 5 || h < 5 || w >= image.cols || h >= image.rows)
        continue;

      cv.resize(ref.grayMat, resized, new cv.Size(w, h));
      cv.matchTemplate(image, resized, result, cv.TM_CCOEFF_NORMED);

      const { maxVal } = cv.minMaxLoc(result);
      if (maxVal > maxScore) maxScore = maxVal;
    }
    if (maxScore > bestScore) {
      bestScore = maxScore;
      bestScale = scale;
    }
  };

  // 粗探索: 半分の解像度でステップ0.05（matchTemplate計算量が1/4）
  const halfGray = new cv.Mat();
  cv.resize(grayImage, halfGray, new cv.Size(
    Math.round(grayImage.cols / 2),
    Math.round(grayImage.rows / 2),
  ));
  for (let scale = 0.2; scale <= 0.65; scale += 0.05) {
    testScaleOn(halfGray, scale, 0.5);
  }
  halfGray.delete();

  // 精密探索: フル解像度でベスト周辺 ±0.04 をステップ0.02で
  // (粗探索ステップ0.05の最大誤差0.025 < 0.04なので必ず最適値をカバー)
  const fineStart = Math.max(0.2, bestScale - 0.04);
  const fineEnd = Math.min(0.65, bestScale + 0.04);
  for (let scale = fineStart; scale <= fineEnd; scale += 0.02) {
    testScaleOn(grayImage, scale, 1);
  }

  resized.delete();
  result.delete();

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
  margin?: number;
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
  stats: {
    partId: number;
    x: number;
    y: number;
    w: number;
    h: number;
    score?: number;
    margin?: number;
  }[];
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
          score: det.score,
          margin: det.margin,
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
          {
            partId: det.partId,
            x: det.x,
            y: det.y,
            w: det.w,
            h: det.h,
            score: det.score,
            margin: det.margin,
          },
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

  // 行クラスタリング
  const yValues = detections.map((d) => d.y).sort((a, b) => a - b);
  const rows: number[] = [];
  for (const y of yValues) {
    if (!rows.some((ry) => Math.abs(ry - y) < iconSize * 0.5))
      rows.push(y);
  }
  rows.sort((a, b) => a - b);

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
  const tiny = estimatedRadius < 15;
  const lowRes = blurredGray.cols < 700 || estimatedRadius < 18;
  let minR: number, maxR: number, minDist: number, param2: number;
  if (tiny) {
    minR = Math.max(5, Math.round(estimatedRadius * 0.55));
    maxR = Math.round(estimatedRadius * 1.8);
    minDist = Math.max(8, Math.round(estimatedRadius * 1.2));
    param2 = 13;
  } else if (lowRes) {
    minR = Math.max(8, Math.round(estimatedRadius * 0.8));
    maxR = Math.round(estimatedRadius * 1.45);
    minDist = Math.round(estimatedRadius * 1.4);
    param2 = 18;
  } else {
    minR = Math.max(5, Math.round(estimatedRadius * 0.5));
    maxR = Math.round(estimatedRadius * 1.8);
    minDist = Math.round(estimatedRadius * 1.5);
    param2 = 22;
  }

  cv.HoughCircles(
    blurredGray,
    circles,
    cv.HOUGH_GRADIENT,
    1, // dp
    minDist,
    100, // param1 (Canny上限閾値)
    param2, // param2 (累積閾値)
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

// --- 行間隔フィルタ ---

function filterRowsBySpacing(rowYs: number[]): number[] {
  if (rowYs.length <= 3) return rowYs;

  let filtered = [...rowYs].sort((a, b) => a - b);
  let changed = true;

  // IQR（四分位範囲）ベースの外れ値検出で端のゴースト行を除外
  while (changed && filtered.length >= 4) {
    changed = false;

    const spacings: number[] = [];
    for (let i = 1; i < filtered.length; i++) {
      spacings.push(filtered[i] - filtered[i - 1]);
    }
    if (spacings.length < 3) break;

    const sorted = [...spacings].sort((a, b) => a - b);
    const q1 = sorted[Math.floor(sorted.length * 0.25)];
    const q3 = sorted[Math.floor(sorted.length * 0.75)];
    const iqr = q3 - q1;

    // IQRが極端に小さい場合（ほぼ等間隔）は中央値の8%をフォールバック
    const medianSpacing = median(spacings);
    if (medianSpacing <= 0) break;
    const spread = Math.max(iqr, medianSpacing * 0.08);

    const minAllowed = q1 - 1.5 * spread;
    const maxAllowed = q3 + 1.5 * spread;
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
  const xThreshold = medianR * 1.2;
  const xClusters = clusterValuesWithCounts(
    circles.map((c) => c.cx),
    xThreshold,
  ).sort((a, b) => a.center - b.center);

  let supported = xClusters.filter((c) => c.count >= 2);
  if (supported.length === 0) supported = xClusters;

  let colXs: number[];
  if (supported.length > maxColsPerRow) {
    let bestWindow: ClusterCandidate[] | null = null;
    let bestScore = -1;
    for (let i = 0; i <= supported.length - maxColsPerRow; i++) {
      const window = supported.slice(i, i + maxColsPerRow);
      const support = window.reduce((s, c) => s + c.count, 0);
      let regularity = 0;
      if (window.length > 1) {
        const gaps: number[] = [];
        for (let j = 0; j < window.length - 1; j++) {
          gaps.push(window[j + 1].center - window[j].center);
        }
        const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
        const irregularity = gaps.reduce((s, g) => s + Math.abs(g - medGap), 0);
        regularity = Math.max(0, 1 - irregularity / (medianR * 4));
      }
      const rightBias = window[window.length - 1].center * 0.001;
      const score = support * 10 + regularity * 50 + rightBias;
      if (score > bestScore) {
        bestScore = score;
        bestWindow = window;
      }
    }
    colXs = bestWindow!.map((c) => c.center);
  } else {
    colXs = supported.slice(0, maxColsPerRow).map((c) => c.center);
  }

  return colXs;
}

function selectRowYsForColumns(
  circles: Circle[],
  globalCols: number[],
  medianR: number,
  imgHeight: number,
  estimatedRadius: number,
): number[] {
  if (globalCols.length === 0) return [];

  const colThreshold = medianR * 1.4;
  const aligned = circles.filter((c) =>
    globalCols.some((colX) => Math.abs(c.cx - colX) <= colThreshold),
  );

  const rowThreshold = medianR * 1.2;
  const rowClusters = clusterValuesWithCounts(
    aligned.map((c) => c.cy),
    rowThreshold,
  ).sort((a, b) => a.center - b.center);

  const rowYs = rowClusters
    .filter((c) => c.count >= 1)
    .map((c) => c.center);

  const MIN_ROW_Y = 100;
  let validRows = rowYs.filter((ry) => ry >= MIN_ROW_Y);

  if (estimatedRadius < 15) {
    validRows = extrapolateRows(validRows, imgHeight, MIN_ROW_Y);
  }

  return validRows;
}

function extrapolateRows(
  rowYs: number[],
  imgHeight: number,
  minY: number = 100,
): number[] {
  if (rowYs.length < 3) return rowYs;

  const gaps: number[] = [];
  for (let i = 0; i < rowYs.length - 1; i++) {
    gaps.push(rowYs[i + 1] - rowYs[i]);
  }
  const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];

  const regular = gaps.filter((g) => Math.abs(g - medGap) < medGap * 0.3).length;
  if (regular < gaps.length * 0.5) return rowYs;

  const extended = [...rowYs];
  let y = extended[0] - medGap;
  while (y >= minY) {
    extended.unshift(y);
    y -= medGap;
  }
  y = extended[extended.length - 1] + medGap;
  while (y < imgHeight - medGap * 0.3) {
    extended.push(y);
    y += medGap;
  }
  return extended;
}

function buildGridSlots(
  circles: Circle[],
  maxColsPerRow: number = 3,
  imgHeight: number = 0,
  estimatedRadius: number = 0,
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
  if (filtered.length < 2) {
    return filtered.map((c) => ({ cx: c.cx, cy: c.cy, r: medianR }));
  }

  const rowThreshold = medianR * 1.2;
  const globalCols = selectGlobalStatColumns(
    filtered,
    medianR,
    maxColsPerRow,
  ).sort((a, b) => a - b);

  const validRowYs = selectRowYsForColumns(filtered, globalCols, medianR, imgHeight, estimatedRadius);

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

  return slots;
}

// --- 局所分類（背景バリエーション付き gray_only） ---

interface ClassificationResult {
  detections: Detection[];
  attemptedSlots: number;
  lowConfidenceCount: number;
  avgMargin: number;
  lowRes: boolean;
}

function pruneWeakLeadingColumn(detections: Detection[]): Detection[] {
  if (detections.length < 2) return detections;

  const iconSize = median(detections.map((d) => d.w));
  const threshold = Math.max(12, iconSize * 0.6);
  const sorted = [...detections].sort(
    (a, b) => a.x + a.w / 2 - (b.x + b.w / 2),
  );

  const columns: Detection[][] = [];
  for (const det of sorted) {
    const centerX = det.x + det.w / 2;
    const existing = columns.find((column) => {
      const avgCenter =
        column.reduce((sum, item) => sum + item.x + item.w / 2, 0) /
        column.length;
      return Math.abs(avgCenter - centerX) < threshold;
    });

    if (existing) {
      existing.push(det);
    } else {
      columns.push([det]);
    }
  }

  if (columns.length < 2) return detections;

  columns.sort((a, b) => {
    const ax = a.reduce((sum, det) => sum + det.x + det.w / 2, 0) / a.length;
    const bx = b.reduce((sum, det) => sum + det.x + det.w / 2, 0) / b.length;
    return ax - bx;
  });

  const summarize = (column: Detection[]) => {
    // -Infinity/NaN耐性: 有限値のみで平均を計算
    const validScores = column.map((det) => det.score).filter(isFinite);
    const validMargins = column.map((det) => det.margin ?? 0).filter(isFinite);
    const avgScore =
      validScores.length > 0
        ? validScores.reduce((sum, s) => sum + s, 0) / validScores.length
        : 0;
    const avgMargin =
      validMargins.length > 0
        ? validMargins.reduce((sum, s) => sum + s, 0) / validMargins.length
        : 0;
    const centerX =
      column.reduce((sum, det) => sum + det.x + det.w / 2, 0) / column.length;
    return { column, avgScore, avgMargin, centerX };
  };

  const left = summarize(columns[0]);
  const others = columns.slice(1).map(summarize);
  const validOtherScores = others.map((o) => o.avgScore).filter(isFinite);
  const validOtherMargins = others.map((o) => o.avgMargin).filter(isFinite);
  const otherAvgScore =
    validOtherScores.length > 0
      ? validOtherScores.reduce((sum, s) => sum + s, 0) / validOtherScores.length
      : 0;
  const otherAvgMargin =
    validOtherMargins.length > 0
      ? validOtherMargins.reduce((sum, s) => sum + s, 0) / validOtherMargins.length
      : 0;

  // 先頭列の平均スコアが他列平均の78%未満なら除去
  const shouldDropLeft = left.avgScore < otherAvgScore * 0.78;

  if (!shouldDropLeft) return detections;

  const dropped = new Set(left.column);
  return detections.filter((det) => !dropped.has(det));
}

function classifyAllSlots(
  grayEq: any,
  edgeMat: any,
  grayCl: any,
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
  // 背景合成版テンプレで全体グレー比較（gray_only方式）
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

  try {
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
      // CLAHE画像を使用（Python検証でequalizeHistより+4〜5%精度向上を確認）
      const localGrayRoi = grayCl.roi(localRect);
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

          // gray_only方式: エッジ成分を除去してアイコン全体グレーのみで判定
          // Python検証で99.5%精度を確認（従来の0.5/0.15/0.35は87.6%）
          const combined = grayIconScore;

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
          margin,
        });
      }
    }
  } finally {
    // テンプレート前処理のクリーンアップ（エラー時も確実に解放）
    for (const tmpl of preppedTemplates) {
      for (const variant of tmpl.variants) {
        variant.grayIcon.delete();
        variant.graySymbol.delete();
        variant.edgeSymbol.delete();
        variant.edgeMask.delete();
      }
    }
  }

  return {
    detections: pruneWeakLeadingColumn(detections),
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
  worker: Awaited<ReturnType<typeof import("tesseract.js")["createWorker"]>>,
): Promise<StatEntry[]> {

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

  // OCR用Canvas（再利用）
  const ocrCanvas = document.createElement("canvas");
  const ocrCtx = ocrCanvas.getContext("2d", { willReadFrequently: true })!;

  const buildOcrCanvas = (
    cropX: number,
    cropY: number,
    cropW: number,
    cropH: number,
    threshold: number | null,
    upscale: number,
    mode: "binary-invert" | "binary-normal" | "gray" | "adaptive" | "color-distance",
  ): HTMLCanvasElement => {
    ocrCanvas.width = cropW * upscale;
    ocrCanvas.height = cropH * upscale;
    ocrCtx.imageSmoothingEnabled = false;
    ocrCtx.drawImage(
      sourceCanvas,
      cropX,
      cropY,
      cropW,
      cropH,
      0,
      0,
      ocrCanvas.width,
      ocrCanvas.height,
    );

    const imageData = ocrCtx.getImageData(0, 0, ocrCanvas.width, ocrCanvas.height);
    const w = ocrCanvas.width;
    const h = ocrCanvas.height;

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
    ocrCtx.putImageData(imageData, 0, 0);
    return ocrCanvas;
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
          const ocrInput = buildOcrCanvas(
            crop.cropX,
            crop.cropY,
            crop.cropW,
            crop.cropH,
            attempt.threshold,
            attempt.upscale,
            attempt.mode,
          );
          const { data } = await worker.recognize(ocrInput);
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
            break;
          }
        }
        if (stat.value > 0) break;
      }
    } catch {
      // OCR失敗
    }
    if (stat.value === 0) {
    }
    delete (stat as any)._ocrCrops;
  }

  // OCR用Canvas即時解放
  ocrCanvas.width = 0;
  ocrCanvas.height = 0;

  return stats.filter((s) => s.value > 0);
}

// --- メイン処理 ---

export interface OcrProgress {
  stage: string;
  percent: number;
}

/** サムネイルにラベルを描画するための行位置情報 */
export interface RowPosition {
  /** 行中央Y（元画像ピクセル座標） */
  y: number;
  /** ラベル配置の基準X（元画像ピクセル座標、モジュールアイコン左端付近） */
  x: number;
  /** アイコンの高さ（元画像ピクセル） */
  h: number;
}

export interface ProcessScreenshotResult {
  modules: ModuleInput[];
  rowPositions: RowPosition[];
}

// --- モジュールアイコン分類 ---

interface ModuleIconMatch {
  type: string;
  rarity: number;
  configId: number;
  score: number;
  margin: number;
  x: number;
  y: number;
  w: number;
  h: number;
  baseRgbType?: string;
  baseRgbScore?: number;
  ahashDistance?: number;
  ahashReranked?: boolean;
}

const TYPE_DIGIT_MAP: Record<string, number> = { attack: 1, device: 2, protect: 3 };
const MODULE_USER_TEMPLATE_MIN_SCORE = 0.275;
const MODULE_USER_TEMPLATE_AHASH_SCORE_MAX = 0.33;
const MODULE_USER_TEMPLATE_AHASH_MAX_DISTANCE = 0.205;

function buildConfigId(typeName: string, rarity: number): number {
  const typeDigit = TYPE_DIGIT_MAP[typeName] ?? 0;
  const rareSub = rarity - 1; // rarity 2→1, 3→2, 4→3, 5→4
  return (55000 + typeDigit) * 100 + rareSub;
}

function computeAverageHash(srcMat: any, cv: any): number[] {
  const gray = new cv.Mat();
  const channels = typeof srcMat.channels === "function" ? srcMat.channels() : 4;
  if (channels === 1) {
    srcMat.copyTo(gray);
  } else if (channels === 3) {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGB2GRAY);
  } else {
    cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  }

  const resized = new cv.Mat();
  cv.resize(gray, resized, new cv.Size(8, 8), 0, 0, cv.INTER_AREA);

  let sum = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      sum += resized.ucharAt(y, x);
    }
  }
  const avg = sum / 64;
  const hash = new Array<number>(64);
  let idx = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      hash[idx++] = resized.ucharAt(y, x) > avg ? 1 : 0;
    }
  }

  gray.delete();
  resized.delete();
  return hash;
}

function normalizedHammingDistance(hashA: number[], hashB: number[]): number {
  if (hashA.length !== hashB.length || hashA.length === 0) return Number.POSITIVE_INFINITY;
  let diff = 0;
  for (let i = 0; i < hashA.length; i++) {
    if (hashA[i] !== hashB[i]) diff++;
  }
  return diff / hashA.length;
}

function estimateModuleScaleFromRow(row: ModuleRow): number {
  const statWidths = row.stats.map((s) => s.w).filter((w) => w > 0);
  if (statWidths.length === 0) return 0.32;

  const medianStatWidth = median(statWidths);
  const estimatedModuleWidth = medianStatWidth * 2.05;
  return Math.max(0.22, Math.min(0.42, estimatedModuleWidth / 256));
}

// OCR_*.png グレースケールテンプレートによるスライディング検出。
// 検証で sl_gray (97.3%) として高精度を確認。
// grayImage には equalizeHist 版またはCLAHE版を渡す。
function classifyModuleIconByOcrGraySliding(
  grayImage: any,
  row: ModuleRow,
  moduleScale: number,
  cv: any,
  filterRarities?: number[],
  filterTypes?: string[],
): ModuleIconMatch | null {
  if (userModuleOcrTemplates.length === 0 || row.stats.length === 0) return null;

  const baseModuleScale = moduleScale;

  // スライディング検索領域: 画像の左30%、行のY位置周辺
  const modPx = Math.round(256 * baseModuleScale);
  const sw = Math.round(grayImage.cols * 0.3);
  const hh = Math.round(modPx * 0.7);
  const y1 = Math.max(0, Math.round(row.y - hh));
  const y2 = Math.min(grayImage.rows, Math.round(row.y + hh));

  if (y2 <= y1 || y2 - y1 < 20 || sw < 20) return null;

  const roiRect = new cv.Rect(0, y1, sw, y2 - y1);
  const roiGray = grayImage.roi(roiRect);

  let bestMatch: ModuleIconMatch | null = null;
  let secondBestScore = -1;
  const result = new cv.Mat();
  const resizedTmpl = new cv.Mat();

  const scaleMultipliers = [0.85, 0.9, 0.95, 1.0, 1.05, 1.1];

  for (const m of scaleMultipliers) {
    const sc = baseModuleScale * m;

    for (const tmpl of userModuleOcrTemplates) {
      // フィルタ: レアリティ・型が指定されていれば該当するものだけ処理
      if (filterRarities && filterRarities.length > 0 && !filterRarities.includes(tmpl.rarity)) continue;
      if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(tmpl.type)) continue;
      // grayEqMat はテンプレート読み込み時にキャッシュ済み
      const tw = Math.round(tmpl.grayEqMat.cols * sc);
      const th = Math.round(tmpl.grayEqMat.rows * sc);
      if (tw < 20 || th < 20 || tw >= roiGray.cols || th >= roiGray.rows) {
        continue;
      }

      cv.resize(tmpl.grayEqMat, resizedTmpl, new cv.Size(tw, th));
      cv.matchTemplate(roiGray, resizedTmpl, result, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(result);
      const score = isNaN(mm.maxVal) ? 0 : mm.maxVal;

      if (bestMatch === null || score > bestMatch.score) {
        secondBestScore = bestMatch?.score ?? -1;
        bestMatch = {
          type: tmpl.type,
          rarity: tmpl.rarity,
          configId: buildConfigId(tmpl.type, tmpl.rarity),
          score,
          margin: 0,
          x: mm.maxLoc.x,
          y: y1 + mm.maxLoc.y,
          w: tw,
          h: th,
        };
      } else if (score > secondBestScore) {
        secondBestScore = score;
      }
    }
  }

  result.delete();
  resizedTmpl.delete();
  roiGray.delete();

  if (bestMatch) {
    bestMatch.margin = secondBestScore >= 0 ? bestMatch.score - secondBestScore : 0;
  }

  return bestMatch;
}

function classifyModuleIconByExistingTemplates(
  grayEq: any,
  edgeMat: any,
  row: ModuleRow,
  statScale: number,
  moduleScale: number,
  cv: any,
  filterRarities?: number[],
  filterTypes?: string[],
): ModuleIconMatch | null {
  if (moduleIconTemplates.length === 0 || row.stats.length === 0) return null;

  const baseModuleScale = moduleScale;

  // 画像左30%、行Y±modPx*0.7
  const modPx = Math.round(256 * baseModuleScale);
  const sw = Math.round(grayEq.cols * 0.3);
  const hh = Math.round(modPx * 0.7);
  const roiY = Math.max(0, Math.round(row.y - hh));
  const roiH = Math.min(grayEq.rows, Math.round(row.y + hh)) - roiY;

  if (roiH < 20 || sw < 20) return null;

  const roiRect = new cv.Rect(0, roiY, sw, roiH);
  const roiGray = grayEq.roi(roiRect);
  const roiEdge = edgeMat.roi(roiRect);

  let bestMatch: ModuleIconMatch | null = null;
  let secondBestScore = -1;

  const scaleCandidates = new Set<number>([
    baseModuleScale * 0.85,
    baseModuleScale * 0.9,
    baseModuleScale * 0.95,
    baseModuleScale,
    baseModuleScale * 1.05,
    baseModuleScale * 1.1,
  ]);
  const scaleRange = [...scaleCandidates].sort((a, b) => a - b);

  const resizedEdge = new cv.Mat();
  const edgeResult = new cv.Mat();
  const resizedGray = new cv.Mat();
  const grayResult = new cv.Mat();

  for (const scaleMul of scaleRange) {
    const modScale = scaleMul;

    for (const tmpl of moduleIconTemplates) {
      if (filterRarities && filterRarities.length > 0 && !filterRarities.includes(tmpl.rarity)) continue;
      if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(tmpl.type)) continue;
      const tw = Math.round(tmpl.edgeMat.cols * modScale);
      const th = Math.round(tmpl.edgeMat.rows * modScale);
      if (tw < 10 || th < 10 || tw >= sw || th >= roiH) continue;

      // エッジマッチング
      cv.resize(tmpl.edgeMat, resizedEdge, new cv.Size(tw, th));
      cv.matchTemplate(roiEdge, resizedEdge, edgeResult, cv.TM_CCOEFF_NORMED);
      const edgeLoc = cv.minMaxLoc(edgeResult);
      const edgeScore = edgeLoc.maxVal;

      // グレーマッチング (best variant)
      let bestGrayScore = 0;
      for (const variant of tmpl.classifyVariants) {
        cv.resize(variant.grayMat, resizedGray, new cv.Size(tw, th));
        cv.matchTemplate(roiGray, resizedGray, grayResult, cv.TM_CCOEFF_NORMED);
        const gs = cv.minMaxLoc(grayResult).maxVal;
        if (gs > bestGrayScore) bestGrayScore = gs;
      }

      const combined = edgeScore * 0.5 + bestGrayScore * 0.5;

      if (!bestMatch || combined > bestMatch.score) {
        if (bestMatch) secondBestScore = Math.max(secondBestScore, bestMatch.score);
        bestMatch = {
          type: tmpl.type,
          rarity: tmpl.rarity,
          configId: buildConfigId(tmpl.type, tmpl.rarity),
          score: combined,
          margin: 0,
          x: edgeLoc.maxLoc.x,
          y: roiY + edgeLoc.maxLoc.y,
          w: tw,
          h: th,
        };
      } else if (combined > secondBestScore) {
        secondBestScore = combined;
      }
    }
  }

  resizedEdge.delete();
  edgeResult.delete();
  resizedGray.delete();
  grayResult.delete();
  roiGray.delete();
  roiEdge.delete();

  if (bestMatch) {
    bestMatch.margin =
      secondBestScore >= 0 ? bestMatch.score - secondBestScore : Number.POSITIVE_INFINITY;
  }

  // 信頼度が低すぎる場合はnull
  if (bestMatch && bestMatch.score < 0.2) {
    return null;
  }

  if (bestMatch) {
  }

  return bestMatch;
}

function classifyModuleIconByUserTemplates(
  colorMat: any,
  row: ModuleRow,
  moduleScale: number,
  cv: any,
  filterRarities?: number[],
  filterTypes?: string[],
): ModuleIconMatch | null {
  if (userModuleOcrTemplates.length === 0 || row.stats.length === 0) return null;

  interface UserModuleCandidate {
    template: UserModuleOcrTemplateInfo;
    score: number;
    localX: number;
    localY: number;
    x: number;
    y: number;
    w: number;
    h: number;
  }

  const leftStat = row.stats.reduce((min, s) => (s.x < min.x ? s : min), row.stats[0]);
  const derivedModuleScale = estimateModuleScaleFromRow(row);
  const useDetectedScale =
    Number.isFinite(moduleScale) &&
    Math.abs(moduleScale - derivedModuleScale) <= 0.08;
  const baseModuleScale = useDetectedScale ? moduleScale : derivedModuleScale;

  const tileSize = Math.max(80, Math.min(108, Math.round(256 * baseModuleScale * 1.02)));
  const tileX = Math.max(0, Math.round(leftStat.x - tileSize * 1.33));
  const tileY = Math.max(0, Math.round(leftStat.y - tileSize * 0.2));
  const tileW = Math.min(tileSize, colorMat.cols - tileX);
  const tileH = Math.min(tileSize, colorMat.rows - tileY);
  if (tileW < 50 || tileH < 50) return null;

  const roiRect = new cv.Rect(tileX, tileY, tileW, tileH);
  const roiColor = colorMat.roi(roiRect);
  const expCx = tileW / 2;
  const expCy = tileH / 2 + tileSize * 0.04;
  const sizeRatios = [0.53, 0.61, 0.69, 0.78, 0.86];

  const topCandidates: UserModuleCandidate[] = [];

  const resizedUser = new cv.Mat();
  const resultUser = new cv.Mat();

  for (const tmpl of userModuleOcrTemplates) {
    if (filterRarities && filterRarities.length > 0 && !filterRarities.includes(tmpl.rarity)) continue;
    if (filterTypes && filterTypes.length > 0 && !filterTypes.includes(tmpl.type)) continue;
    for (const ratio of sizeRatios) {
      const tw = Math.round(tileSize * ratio);
      const th = tw;
      if (tw < 24 || th < 24 || tw >= tileW || th >= tileH) continue;

      cv.resize(tmpl.colorMat, resizedUser, new cv.Size(tw, th));
      cv.matchTemplate(roiColor, resizedUser, resultUser, cv.TM_CCOEFF_NORMED);
      const { maxVal, maxLoc } = cv.minMaxLoc(resultUser);

      const cx = maxLoc.x + tw / 2;
      const cy = maxLoc.y + th / 2;
      const penalty = 0.01 * (Math.abs(cx - expCx) + Math.abs(cy - expCy));
      const score = maxVal - penalty;

      topCandidates.push({
        template: tmpl,
        score,
        localX: maxLoc.x,
        localY: maxLoc.y,
        x: tileX + maxLoc.x,
        y: tileY + maxLoc.y,
        w: tw,
        h: th,
      });
      topCandidates.sort((a, b) => b.score - a.score);
      if (topCandidates.length > 3) {
        topCandidates.length = 3;
      }
    }
  }

  resizedUser.delete();
  resultUser.delete();

  const bestCandidate = topCandidates[0];
  roiColor.delete();

  if (!bestCandidate) return null;

  let selectedCandidate = bestCandidate;
  let ahashDistance: number | undefined;
  let ahashReranked = false;

  if (
    bestCandidate.template.type !== "device" &&
    bestCandidate.score <= MODULE_USER_TEMPLATE_AHASH_SCORE_MAX &&
    topCandidates.length > 0
  ) {
    let bestHashCandidate = bestCandidate;
    let bestHashDistance = Number.POSITIVE_INFINITY;

    for (const candidate of topCandidates) {
      const patch = colorMat.roi(new cv.Rect(candidate.x, candidate.y, candidate.w, candidate.h));
      const patchHash = computeAverageHash(patch, cv);
      patch.delete();

      const distance = normalizedHammingDistance(patchHash, candidate.template.avgHash);
      if (distance < bestHashDistance) {
        bestHashDistance = distance;
        bestHashCandidate = candidate;
      }
    }

    ahashDistance = bestHashDistance;
    if (bestHashDistance <= MODULE_USER_TEMPLATE_AHASH_MAX_DISTANCE) {
      selectedCandidate = bestHashCandidate;
      ahashReranked = bestHashCandidate !== bestCandidate;
    }
  }

  const secondBestScore = topCandidates[1]?.score ?? -1;
  const match: ModuleIconMatch = {
    type: selectedCandidate.template.type,
    rarity: selectedCandidate.template.rarity,
    configId: buildConfigId(selectedCandidate.template.type, selectedCandidate.template.rarity),
    score: selectedCandidate.score,
    margin: secondBestScore >= 0 ? bestCandidate.score - secondBestScore : Number.POSITIVE_INFINITY,
    x: selectedCandidate.x,
    y: selectedCandidate.y,
    w: selectedCandidate.w,
    h: selectedCandidate.h,
    baseRgbType: bestCandidate.template.type,
    baseRgbScore: bestCandidate.score,
    ahashDistance,
    ahashReranked,
  };

  return match;
}

function classifyModuleIconForRow(
  colorMat: any,
  grayEq: any,
  edgeMat: any,
  grayCl: any,
  row: ModuleRow,
  statScale: number,
  moduleScale: number,
  cv: any,
  filterRarities?: number[],
  filterTypes?: string[],
): ModuleIconMatch | null {
  // 3手法のアンサンブル（多数決）で分類精度を最大化。
  // テスト検証: 単一手法の最良 sl_gray=97.3% → 多数決100%
  //
  // sl_edge相当: 既存テンプレート（edge+gray, equalizeHist）
  const slEdge = classifyModuleIconByExistingTemplates(
    grayEq, edgeMat, row, statScale, moduleScale, cv, filterRarities, filterTypes,
  );
  // sl_gray相当: OCRグレーテンプレート（equalizeHist）
  const slGray = classifyModuleIconByOcrGraySliding(
    grayEq, row, moduleScale, cv, filterRarities, filterTypes,
  );
  // cl_gray相当: OCRグレーテンプレート（CLAHE）
  const clGray = classifyModuleIconByOcrGraySliding(
    grayCl, row, moduleScale, cv, filterRarities, filterTypes,
  );

  // 多数決: type+rarity の組み合わせで投票
  const candidates = [slEdge, slGray, clGray].filter(
    (m): m is ModuleIconMatch => m !== null,
  );

  let ensembleMatch: ModuleIconMatch | null = null;
  if (candidates.length > 0) {
    const votes: Record<string, { count: number; bestMatch: ModuleIconMatch }> = {};
    for (const m of candidates) {
      const key = `${m.type}${m.rarity}`;
      if (!votes[key]) {
        votes[key] = { count: 0, bestMatch: m };
      }
      votes[key].count++;
      if (m.score > votes[key].bestMatch.score) {
        votes[key].bestMatch = m;
      }
    }
    // 最多得票を選択。同票ならスコアが高い方
    const ranked = Object.values(votes).sort(
      (a, b) => b.count - a.count || b.bestMatch.score - a.bestMatch.score,
    );
    ensembleMatch = ranked[0].bestMatch;

  }

  // ユーザーテンプレートも試行（カラーマッチング + averageHash）
  const userMatch = classifyModuleIconByUserTemplates(colorMat, row, moduleScale, cv, filterRarities, filterTypes);

  const userHashTrusted =
    !!userMatch &&
    userMatch.baseRgbType !== "device" &&
    (userMatch.baseRgbScore ?? userMatch.score) <= MODULE_USER_TEMPLATE_AHASH_SCORE_MAX &&
    (userMatch.ahashDistance ?? Number.POSITIVE_INFINITY) <= MODULE_USER_TEMPLATE_AHASH_MAX_DISTANCE;
  const useUserMatch =
    !!userMatch &&
    (userMatch.score >= MODULE_USER_TEMPLATE_MIN_SCORE || userHashTrusted);

  // 既存TMのスコアがユーザーTMより十分高い場合は既存TMを優先
  const existingClearlyBetter =
    !!ensembleMatch &&
    !!userMatch &&
    ensembleMatch.score > userMatch.score + 0.08;

  const chosen = (useUserMatch && !existingClearlyBetter) ? userMatch : ensembleMatch;

  return chosen;
}



// ========== 詳細設定モード: グリッド交点ベース検出 ==========

// Step 1: スケールとアンカー位置を検出
// 前回検出したスケールをキャッシュ（複数枚処理時に2枚目以降を高速化）
let _lastCustomScale: number | null = null;
let _lastCustomColXs: number[] | null = null;

export function resetCustomScaleCache(): void {
  _lastCustomScale = null;
  _lastCustomColXs = null;
}

function customDetectScaleAndAnchor(
  grayEq: any,
  cv: any,
  imgWidth: number,
  imgHeight: number,
  platform: "mobile" | "pc",
): { scale: number; anchorX: number; anchorY: number; iconSize: number } | null {
  // 画像サイズからスケールを推定（粗探索を省略して速度向上）
  // PC: UIは16:9を上限としてスケーリングされるため、ウルトラワイド等では高さから16:9相当の幅を逆算
  // mobile: sqrt(W×H)基準 (sqrt(W×H) / iconSize ≈ 43.4, scale ≈ sqrt(W×H) / 3470)
  const estimatedScale = platform === "mobile"
    ? Math.sqrt(imgWidth * imgHeight) / 3470
    : Math.min(imgWidth, imgHeight * 16 / 9) / 5780;

  const refs = statTemplates.slice(0, 8);
  let bestScale = 0, bestScore = -1, bestX = 0, bestY = 0;
  const result = new cv.Mat();

  const testScale = (scale: number) => {
    for (const ref of refs) {
      const tw = Math.round(ref.grayMat.cols * scale);
      const th = Math.round(ref.grayMat.rows * scale);
      if (tw >= grayEq.cols || th >= grayEq.rows || tw < 10 || th < 10) continue;
      const r = new cv.Mat();
      cv.resize(ref.grayMat, r, new cv.Size(tw, th));
      cv.matchTemplate(grayEq, r, result, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(result);
      if (mm.maxVal > bestScore) {
        bestScore = mm.maxVal;
        bestScale = scale;
        bestX = mm.maxLoc.x;
        bestY = mm.maxLoc.y;
      }
      r.delete();
    }
  };

  // 推定スケール周辺の探索（実測の最大誤差 ±0.015 に対して ±0.05 で十分なマージン）
  const searchCenter = _lastCustomScale ?? estimatedScale;
  for (let scale = searchCenter - 0.05; scale <= searchCenter + 0.05; scale += 0.01) {
    if (scale < 0.10 || scale > 0.80) continue;
    testScale(scale);
  }

  // スコアが低い場合、推定値ベースで再探索（キャッシュが外れた場合のフォールバック）
  if (bestScore < 0.3 && _lastCustomScale !== null) {
    bestScore = -1;
    bestScale = 0;
    for (let scale = estimatedScale - 0.05; scale <= estimatedScale + 0.05; scale += 0.01) {
      if (scale < 0.10 || scale > 0.80) continue;
      testScale(scale);
    }
  }

  // 精密探索
  const fineCenter = bestScale;
  for (let scale = fineCenter - 0.03; scale <= fineCenter + 0.03; scale += 0.005) {
    if (scale < 0.10 || scale > 0.80) continue;
    testScale(scale);
  }

  result.delete();
  if (bestScore < 0.3) {
    _lastCustomScale = null;
    return null;
  }

  // 成功したスケールをキャッシュ
  _lastCustomScale = bestScale;

  const iconSize = Math.round(80 * bestScale);
  return {
    scale: bestScale,
    anchorX: bestX + iconSize / 2,
    anchorY: bestY + iconSize / 2,
    iconSize,
  };
}

// Step 2: 列位置を検出（水平方向のスコアプロファイル）
function customDetectColumns(
  grayEq: any,
  anchorY: number,
  iconSize: number,
  scale: number,
  cv: any,
): number[] {
  const searchH = Math.round(iconSize * 1.5);
  const y0 = Math.max(0, Math.round(anchorY - searchH / 2));
  const y1 = Math.min(grayEq.rows, y0 + searchH);
  if (y1 - y0 < iconSize) return [];

  const roi = grayEq.roi(new cv.Rect(0, y0, grayEq.cols, y1 - y0));
  const result = new cv.Mat();

  const xScores = new Float64Array(grayEq.cols);
  const refs = statTemplates.slice(0, 8);
  for (const ref of refs) {
    for (const v of ref.classifyVariants) {
      const tw = Math.round(v.grayMat.cols * scale);
      const th = Math.round(v.grayMat.rows * scale);
      if (tw >= roi.cols || th >= roi.rows || tw < 5 || th < 5) continue;
      const tmpl = new cv.Mat();
      cv.resize(v.grayMat, tmpl, new cv.Size(tw, th));
      cv.matchTemplate(roi, tmpl, result, cv.TM_CCOEFF_NORMED);
      for (let x = 0; x < result.cols; x++) {
        let colMax = 0;
        for (let y = 0; y < result.rows; y++) {
          const val = result.floatAt(y, x);
          if (val > colMax) colMax = val;
        }
        if (colMax > xScores[x]) xScores[x] = colMax;
      }
      tmpl.delete();
    }
  }
  roi.delete();
  result.delete();

  // NMS風ピーク検出
  const minDist = Math.round(iconSize * 0.8);
  const threshold = 0.3;
  const peaks: { x: number; score: number }[] = [];
  for (let x = 0; x < xScores.length; x++) {
    if (xScores[x] < threshold) continue;
    let isPeak = true;
    for (let dx = -minDist; dx <= minDist; dx++) {
      const nx = x + dx;
      if (nx >= 0 && nx < xScores.length && nx !== x && xScores[nx] > xScores[x]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) peaks.push({ x: x + iconSize / 2, score: xScores[x] });
  }

  // スコア0.6以上のピークを採用（最大3列）
  const strongPeaks = peaks.filter((p) => p.score >= 0.6).sort((a, b) => b.score - a.score).slice(0, 3);
  if (strongPeaks.length >= 2) {
    const sorted = strongPeaks.sort((a, b) => a.x - b.x);
    // 2列時は3列目を間隔から推定
    if (sorted.length === 2) {
      const gap = sorted[1].x - sorted[0].x;
      const thirdX = sorted[1].x + gap;
      if (thirdX < grayEq.cols - iconSize / 2) {
        sorted.push({ x: thirdX, score: 0.3 });
      }
    }
    return sorted.map((p) => p.x);
  }

  // フォールバック: 等間隔の3列組み合わせを選択
  peaks.sort((a, b) => a.x - b.x);
  if (peaks.length <= 3) return peaks.map((p) => p.x).sort((a, b) => a - b);

  let best3: number[] = [];
  let bestCombo = -1;
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      for (let k = j + 1; k < peaks.length; k++) {
        const g1 = peaks[j].x - peaks[i].x;
        const g2 = peaks[k].x - peaks[j].x;
        const avg = (g1 + g2) / 2;
        if (avg < iconSize * 0.5) continue;
        const regularity = 1 - Math.abs(g1 - g2) / avg;
        if (regularity < 0.7) continue;
        const score = (peaks[i].score + peaks[j].score + peaks[k].score) * regularity;
        if (score > bestCombo) {
          bestCombo = score;
          best3 = [peaks[i].x, peaks[j].x, peaks[k].x];
        }
      }
    }
  }
  return best3.length === 3 ? best3 : peaks.slice(0, 3).map((p) => p.x);
}

// Step 3: 行位置を検出（縦方向のスコアプロファイル）
function customDetectRows(
  grayEq: any,
  colXs: number[],
  iconSize: number,
  scale: number,
  cv: any,
): number[] {
  if (colXs.length === 0) return [];

  const result = new cv.Mat();
  const yScores = new Float64Array(grayEq.rows);
  const refs = statTemplates.slice(0, 8);
  const halfIcon = Math.round(iconSize / 2);

  for (const cx of colXs) {
    const roiX = Math.max(0, Math.round(cx - halfIcon - 5));
    const roiW = Math.min(iconSize + 10, grayEq.cols - roiX);
    if (roiW < iconSize) continue;
    const roi = grayEq.roi(new cv.Rect(roiX, 0, roiW, grayEq.rows));

    for (const ref of refs) {
      for (const v of ref.classifyVariants) {
        const tw = Math.round(v.grayMat.cols * scale);
        const th = Math.round(v.grayMat.rows * scale);
        if (tw >= roi.cols || th >= roi.rows || tw < 5 || th < 5) continue;
        const tmpl = new cv.Mat();
        cv.resize(v.grayMat, tmpl, new cv.Size(tw, th));
        cv.matchTemplate(roi, tmpl, result, cv.TM_CCOEFF_NORMED);
        for (let y = 0; y < result.rows; y++) {
          let rowMax = 0;
          for (let x = 0; x < result.cols; x++) {
            const val = result.floatAt(y, x);
            if (val > rowMax) rowMax = val;
          }
          if (rowMax > yScores[y]) yScores[y] = rowMax;
        }
        tmpl.delete();
      }
    }
    roi.delete();
  }
  result.delete();

  // ピーク検出
  const minDist = Math.round(iconSize * 1.5);
  const threshold = 0.3;
  const peaks: { y: number; score: number }[] = [];
  for (let y = 0; y < yScores.length; y++) {
    if (yScores[y] < threshold) continue;
    let isPeak = true;
    for (let dy = -minDist; dy <= minDist; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < yScores.length && ny !== y && yScores[ny] > yScores[y]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) peaks.push({ y: y + iconSize / 2, score: yScores[y] });
  }

  // 等間隔フィルタ
  const sorted = peaks.sort((a, b) => a.y - b.y).map((p) => p.y);
  if (sorted.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    return sorted.filter((_, i) => {
      if (i === 0) return true;
      const gap = sorted[i] - sorted[i - 1];
      return Math.abs(gap - medGap) / medGap < 0.3 || gap > medGap * 1.5;
    });
  }
  return sorted;
}

// Step 4: グリッド交点でステータスアイコンを分類
function customClassifyStatAtGrid(
  grayCl: any,
  cx: number,
  cy: number,
  iconSide: number,
  cv: any,
  excludePids?: Set<number>,
): { pid: number; score: number; margin: number } {
  const pad = 3;
  const roiX = Math.max(0, Math.round(cx - iconSide / 2 - pad));
  const roiY = Math.max(0, Math.round(cy - iconSide / 2 - pad));
  const roiS = iconSide + pad * 2;
  if (roiX + roiS > grayCl.cols || roiY + roiS > grayCl.rows) {
    return { pid: -1, score: -Infinity, margin: 0 };
  }

  const roiG = grayCl.roi(new cv.Rect(roiX, roiY, roiS, roiS));
  const result = new cv.Mat();
  const scores: { pid: number; score: number }[] = [];

  for (const tmpl of statTemplates) {
    if (excludePids?.has(tmpl.partId)) continue;
    let partBest = -Infinity;
    for (const v of tmpl.classifyVariants) {
      const vResized = new cv.Mat();
      cv.resize(v.grayMat, vResized, new cv.Size(iconSide, iconSide));
      if (roiG.rows >= vResized.rows && roiG.cols >= vResized.cols) {
        cv.matchTemplate(roiG, vResized, result, cv.TM_CCOEFF_NORMED);
        const s = cv.minMaxLoc(result).maxVal;
        if (!isNaN(s) && s > partBest) partBest = s;
      }
      vResized.delete();
    }
    scores.push({ pid: tmpl.partId, score: partBest });
  }

  roiG.delete();
  result.delete();

  scores.sort((a, b) => b.score - a.score);
  if (scores.length === 0) return { pid: -1, score: -Infinity, margin: 0 };
  return {
    pid: scores[0].pid,
    score: scores[0].score,
    margin: scores.length >= 2 ? scores[0].score - scores[1].score : 0,
  };
}

// confident判定（詳細設定モード用）
function isCustomStatConfident(score: number, margin: number): boolean {
  return score >= 0.55 || (score >= 0.50 && margin >= 0.015);
}

// --- テンプレート列検出: アンカー実測gapで3列位置を推定 ---

function customDetectColumnsFromAnchors(
  grayEq: any,
  cv: any,
  scale: number,
  iconSize: number,
): number[] | null {
  const refs = statTemplates.slice(0, 8);
  const result = new cv.Mat();
  const hits: { x: number; y: number; score: number }[] = [];

  for (const ref of refs) {
    const tw = Math.round(ref.grayMat.cols * scale);
    const th = Math.round(ref.grayMat.rows * scale);
    if (tw >= grayEq.cols || th >= grayEq.rows || tw < 10 || th < 10) continue;
    const r = new cv.Mat();
    cv.resize(ref.grayMat, r, new cv.Size(tw, th));
    cv.matchTemplate(grayEq, r, result, cv.TM_CCOEFF_NORMED);
    for (let y = 0; y < result.rows; y++) {
      for (let x = 0; x < result.cols; x++) {
        const s = result.floatAt(y, x);
        if (s >= 0.5) hits.push({ x: x + iconSize / 2, y: y + iconSize / 2, score: s });
      }
    }
    r.delete();
  }
  result.delete();

  // NMS
  hits.sort((a, b) => b.score - a.score);
  const anchors: typeof hits = [];
  const minDist = iconSize * 0.5;
  for (const h of hits) {
    if (anchors.some((k) => Math.abs(k.x - h.x) < minDist && Math.abs(k.y - h.y) < minDist)) continue;
    anchors.push(h);
    if (anchors.length >= 30) break;
  }
  if (anchors.length < 4) return null;

  // 同行ペアからgapを実測
  const approxGap = iconSize * 2.65;
  const measuredGaps: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    for (let j = i + 1; j < anchors.length; j++) {
      if (Math.abs(anchors[i].y - anchors[j].y) > iconSize * 1.5) continue;
      const dx = Math.abs(anchors[i].x - anchors[j].x);
      const colDiff = Math.round(dx / approxGap);
      if (colDiff === 0 || colDiff > 2) continue;
      const gap = dx / colDiff;
      if (gap > iconSize * 1.5 && gap < iconSize * 4) measuredGaps.push(gap);
    }
  }
  if (measuredGaps.length < 2) return null;
  measuredGaps.sort((a, b) => a - b);
  const gap = measuredGaps[Math.floor(measuredGaps.length / 2)];

  // アンカーから3列位置を推定
  const top = anchors[0];
  const colIndices = anchors.map((a) => Math.round((a.x - top.x) / gap));
  const uniqueIdx = [...new Set(colIndices)].sort((a, b) => a - b);
  const minIdx = Math.min(...uniqueIdx);
  const maxIdx = Math.max(...uniqueIdx);
  let bestStart = minIdx;
  let bestCount = 0;
  for (let s = minIdx; s <= maxIdx - 2; s++) {
    const c = colIndices.filter((ci) => ci >= s && ci <= s + 2).length;
    if (c > bestCount) { bestCount = c; bestStart = s; }
  }
  if (bestCount === 0) bestStart = minIdx;

  const leftCandidates: number[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const ci = colIndices[i];
    if (ci >= bestStart && ci <= bestStart + 2) {
      leftCandidates.push(anchors[i].x - (ci - bestStart) * gap);
    }
  }
  leftCandidates.sort((a, b) => a - b);
  const col1X = leftCandidates[Math.floor(leftCandidates.length / 2)];

  const colXs = [col1X, col1X + gap, col1X + 2 * gap].filter(
    (x) => x > iconSize * 0.3 && x < grayEq.cols - iconSize * 0.3,
  );
  return colXs.length >= 2 ? colXs : null;
}

// --- カラーマッチングによるステータスアイコン分類 ---

function customClassifyStatByColor(
  colorMat: any,
  cx: number,
  cy: number,
  iconSide: number,
  cv: any,
  excludePids?: Set<number>,
): { pid: number; score: number; margin: number } {
  const pad = 3;
  const roiX = Math.max(0, Math.round(cx - iconSide / 2 - pad));
  const roiY = Math.max(0, Math.round(cy - iconSide / 2 - pad));
  const roiS = iconSide + pad * 2;
  if (roiX + roiS > colorMat.cols || roiY + roiS > colorMat.rows) {
    return { pid: -1, score: -Infinity, margin: 0 };
  }

  const roi = colorMat.roi(new cv.Rect(roiX, roiY, roiS, roiS));
  const result = new cv.Mat();
  const scores: { pid: number; score: number }[] = [];

  for (const tmpl of statTemplates) {
    if (excludePids?.has(tmpl.partId)) continue;
    let partBest = -Infinity;
    for (const v of tmpl.colorVariants) {
      const resized = new cv.Mat();
      cv.resize(v.colorMat, resized, new cv.Size(iconSide, iconSide));
      if (roi.rows >= resized.rows && roi.cols >= resized.cols) {
        cv.matchTemplate(roi, resized, result, cv.TM_CCOEFF_NORMED);
        const s = cv.minMaxLoc(result).maxVal;
        if (!isNaN(s) && s > partBest) partBest = s;
      }
      resized.delete();
    }
    scores.push({ pid: tmpl.partId, score: partBest });
  }

  roi.delete();
  result.delete();

  scores.sort((a, b) => b.score - a.score);
  if (scores.length === 0) return { pid: -1, score: -Infinity, margin: 0 };
  return {
    pid: scores[0].pid,
    score: scores[0].score,
    margin: scores.length >= 2 ? scores[0].score - scores[1].score : 0,
  };
}

// カラーマッチング用confident判定（スコアが高いので閾値を調整）
function isColorStatConfident(score: number): boolean {
  return score >= 0.50;
}

// --- モジュールアイコン カラーマッチング分類 ---

function classifyModuleIconByColor(
  colorMat: any,
  cx: number,
  cy: number,
  moduleScale: number,
  cv: any,
  filterRarities?: number[],
  filterTypes?: string[],
): ModuleIconMatch | null {
  if (moduleIconTemplates.length === 0) return null;

  const refTmpl = moduleIconTemplates[0];
  const expectedW = Math.round(refTmpl.edgeMat.cols * moduleScale);
  const expectedH = Math.round(refTmpl.edgeMat.rows * moduleScale);

  const padX = Math.round(expectedW * 0.5);
  const padY = Math.round(expectedH * 0.5);
  const roiX = Math.max(0, Math.round(cx - expectedW / 2 - padX));
  const roiY = Math.max(0, Math.round(cy - expectedH / 2 - padY));
  const roiW = Math.min(expectedW + padX * 2, colorMat.cols - roiX);
  const roiH = Math.min(expectedH + padY * 2, colorMat.rows - roiY);
  if (roiW < expectedW || roiH < expectedH) return null;

  const roi = colorMat.roi(new cv.Rect(roiX, roiY, roiW, roiH));
  const result = new cv.Mat();
  const resized = new cv.Mat();

  let bestMatch: ModuleIconMatch | null = null;
  let secondBestScore = -1;

  for (const tmpl of moduleIconTemplates) {
    if (filterRarities?.length && !filterRarities.includes(tmpl.rarity)) continue;
    if (filterTypes?.length && !filterTypes.includes(tmpl.type)) continue;

    let partBest = -Infinity;
    let partLoc = { x: 0, y: 0 };
    let partW = 0, partH = 0;

    for (const v of tmpl.colorVariants) {
      const tw = Math.round(v.colorMat.cols * moduleScale);
      const th = Math.round(v.colorMat.rows * moduleScale);
      if (tw < 10 || th < 10 || tw >= roiW || th >= roiH) continue;

      cv.resize(v.colorMat, resized, new cv.Size(tw, th));
      cv.matchTemplate(roi, resized, result, cv.TM_CCOEFF_NORMED);
      const mm = cv.minMaxLoc(result);
      const score = isNaN(mm.maxVal) ? -Infinity : mm.maxVal;

      if (score > partBest) {
        partBest = score;
        partLoc = mm.maxLoc;
        partW = tw;
        partH = th;
      }
    }

    if (bestMatch === null || partBest > bestMatch.score) {
      secondBestScore = bestMatch?.score ?? -1;
      bestMatch = {
        type: tmpl.type,
        rarity: tmpl.rarity,
        configId: buildConfigId(tmpl.type, tmpl.rarity),
        score: partBest,
        margin: 0,
        x: roiX + partLoc.x,
        y: roiY + partLoc.y,
        w: partW,
        h: partH,
      };
    } else if (partBest > secondBestScore) {
      secondBestScore = partBest;
    }
  }

  roi.delete();
  result.delete();
  resized.delete();

  if (bestMatch) {
    bestMatch.margin = secondBestScore >= 0 ? bestMatch.score - secondBestScore : 0;
  }

  return bestMatch;
}

// ========== 詳細設定モード メインパイプライン ==========

async function processCustomMode(
  canvas: HTMLCanvasElement,
  gray: any,
  grayEq1x: any,
  edgeMat1x: any,
  grayCl1x: any,
  edgeCl1x: any,
  colorMat1x: any,
  cropWidth: number,
  cropHeight: number,
  imgWidth: number,
  imgHeight: number,
  onProgress: ((p: OcrProgress) => void) | undefined,
  externalWorker: any,
  customOptions: OcrCustomOptions | undefined,
  cv: any,
  startUuid: number,
): Promise<ProcessScreenshotResult> {
  const filterRarities = customOptions?.rarities;
  const filterTypes = customOptions?.typeNames;
  const platform = customOptions!.platform;
  const cropX = customOptions?.region ? Math.max(0, Math.round(customOptions.region.x)) : 0;
  const cropY = customOptions?.region ? Math.max(0, Math.round(customOptions.region.y)) : 0;

  // Step 1: グリッド検出（1x解像度で実行）
  onProgress?.({ stage: "グリッド解析中...", percent: 20 });
  const anchor = customDetectScaleAndAnchor(grayEq1x, cv, imgWidth, imgHeight, platform);
  if (!anchor) {
    console.warn("[customOCR] スケール検出失敗");
    gray.delete(); grayEq1x.delete(); edgeMat1x.delete();
    grayCl1x.delete(); edgeCl1x.delete(); colorMat1x.delete();
    canvas.width = 0; canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }
  onProgress?.({ stage: "列検出中...", percent: 30 });
  let colXs: number[];
  if (_lastCustomColXs) {
    // キャッシュがある場合はそのまま使用
    colXs = _lastCustomColXs;
  } else {
    // 両方の列検出を実行し、スコアが高い方を採用
    const templateColXs = customDetectColumnsFromAnchors(grayEq1x, cv, anchor.scale, anchor.iconSize);
    const profileColXs = customDetectColumns(grayEq1x, anchor.anchorY, anchor.iconSize, anchor.scale, cv);
    const colCandidates = [templateColXs, profileColXs.length > 0 ? profileColXs : null]
      .filter((c): c is number[] => c !== null && c.length >= 2);

    if (colCandidates.length === 0) {
      colXs = [];
    } else if (colCandidates.length === 1) {
      colXs = colCandidates[0];
    } else {
      // アンカーY付近でカラーマッチングスコアを比較して列を選択
      // 極端に低いスコア（アイコンがない位置）は平均から除外
      const MIN_SCORE_FOR_AVG = 0.40;
      let bestCols = colCandidates[0];
      let bestAvg = -Infinity;
      for (const cols of colCandidates) {
        let scoreSum = 0, count = 0;
        for (const cx of cols) {
          const r = customClassifyStatByColor(colorMat1x, cx, anchor.anchorY, anchor.iconSize, cv);
          if (isFinite(r.score) && r.score >= MIN_SCORE_FOR_AVG) { scoreSum += r.score; count++; }
        }
        const avg = count > 0 ? scoreSum / count : -Infinity;
        if (avg > bestAvg) { bestAvg = avg; bestCols = cols; }
      }
      colXs = bestCols;
    }
    if (colXs.length >= 2) {
      _lastCustomColXs = colXs; // キャッシュ
    }
  }
  if (colXs.length === 0) {
    console.warn("[customOCR] 列検出失敗");
    gray.delete(); grayEq1x.delete(); edgeMat1x.delete();
    grayCl1x.delete(); edgeCl1x.delete(); colorMat1x.delete();
    canvas.width = 0; canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }
  onProgress?.({ stage: "行検出中...", percent: 35 });
  const rowYs = customDetectRows(grayEq1x, colXs, anchor.iconSize, anchor.scale, cv);
  if (rowYs.length === 0) {
    console.warn("[customOCR] 行検出失敗");
    gray.delete(); grayEq1x.delete(); edgeMat1x.delete();
    grayCl1x.delete(); edgeCl1x.delete(); colorMat1x.delete();
    canvas.width = 0; canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }
  // Step 2: アップスケール
  const upscale = cropHeight < 700 ? 3 : 2;
  const grayUpscaled = new cv.Mat();
  cv.resize(gray, grayUpscaled, new cv.Size(0, 0), upscale, upscale, cv.INTER_CUBIC);
  gray.delete();

  const grayClUp = applyCLAHE(grayUpscaled, cv);
  grayUpscaled.delete();

  // アップスケール座標
  const scaledColXs = colXs.map((x) => x * upscale);
  const scaledRowYs = rowYs.map((y) => y * upscale);
  const scaledIconSize = Math.round(anchor.iconSize * upscale);
  const scaledScale = anchor.scale * upscale;

  // カラー画像をアップスケール（カラーマッチング用）
  const colorMatUp = new cv.Mat();
  cv.resize(colorMat1x, colorMatUp, new cv.Size(0, 0), upscale, upscale, cv.INTER_CUBIC);

  // 1x画像は不要なので解放
  grayEq1x.delete();
  edgeMat1x.delete();
  grayCl1x.delete();
  edgeCl1x.delete();

  // Step 3: グリッド交点でステータス分類（カラーマッチング）
  onProgress?.({ stage: "ステータスアイコン分類中...", percent: 45 });
  const rows: ModuleRow[] = [];

  for (let ri = 0; ri < scaledRowYs.length; ri++) {
    const ry = scaledRowYs[ri];
    const stats: ModuleRow["stats"] = [];

    for (let ci = 0; ci < scaledColXs.length; ci++) {
      const cx = scaledColXs[ci];
      // 列フィルタ: 真ん中・右列で極系除外
      const excludePids = ci >= 1 ? EXTREME_STAT_PIDS : undefined;

      // カラーマッチング（テンプレート列+カラー方式）
      const result = customClassifyStatByColor(colorMatUp, cx, ry, scaledIconSize, cv, excludePids);
      const confident = isColorStatConfident(result.score);

      // フォールバック: カラーで低スコアの場合は従来のCLAHE方式も試す
      if (!confident) {
        const grayResult = customClassifyStatAtGrid(grayClUp, cx, ry, scaledIconSize, cv, excludePids);
        const grayConfident = isCustomStatConfident(grayResult.score, grayResult.margin);
        if (grayConfident) {
          stats.push({
            partId: grayResult.pid,
            x: Math.round(cx - scaledIconSize / 2),
            y: Math.round(ry - scaledIconSize / 2),
            w: scaledIconSize,
            h: scaledIconSize,
            score: grayResult.score,
            margin: grayResult.margin,
          });
        }
        continue;
      }

      stats.push({
        partId: result.pid,
        x: Math.round(cx - scaledIconSize / 2),
        y: Math.round(ry - scaledIconSize / 2),
        w: scaledIconSize,
        h: scaledIconSize,
        score: result.score,
        margin: result.margin,
      });
    }

    rows.push({ y: ry, stats });
    // UIスレッドに制御を返す（撮影ボタンなどのイベントを処理可能にする）
    await new Promise((r) => setTimeout(r, 0));
  }

  // Step 4: モジュールアイコン分類（カラーマッチング）
  onProgress?.({ stage: "モジュールアイコン検出中...", percent: 55 });
  const moduleScale = scaledScale * 0.65;
  const columnGap = scaledColXs.length >= 2
    ? scaledColXs[1] - scaledColXs[0]
    : scaledIconSize * 2;
  const moduleEstX = scaledColXs[0] - columnGap;

  const moduleIcons: (ModuleIconMatch | null)[] = [];
  for (let ri = 0; ri < scaledRowYs.length; ri++) {
    moduleIcons.push(
      classifyModuleIconByColor(
        colorMatUp, moduleEstX, scaledRowYs[ri],
        moduleScale, cv, filterRarities, filterTypes,
      ),
    );
    // UIスレッドに制御を返す
    await new Promise((r) => setTimeout(r, 0));
  }

  colorMatUp.delete();
  colorMat1x.delete();

  // ステータスが4つ以上検出された行はスコア上位3つに絞る
  const anchoredRows = rows.map((row) => {
    if (row.stats.length <= 3) return row;
    const sorted = [...row.stats].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const kept = sorted.slice(0, 3).sort((a, b) => a.x - b.x);
    return { y: row.y, stats: kept };
  });

  grayClUp.delete();

  // Step 5: 数値OCR（1xのcanvasを使用）
  onProgress?.({ stage: "数値読み取り中...", percent: 60 });
  // 数値OCR用: アップスケール座標を1xに変換したcanvasが必要
  // 行・ステータスの座標を1xに戻す
  const ocrRows: ModuleRow[] = anchoredRows.map((row) => ({
    y: row.y / upscale,
    stats: row.stats.map((s) => ({
      ...s,
      x: s.x / upscale,
      y: s.y / upscale,
      w: s.w / upscale,
      h: s.h / upscale,
    })),
  }));
  // moduleIcons座標も1xに変換
  const ocrModuleIcons: (ModuleIconMatch | null)[] = moduleIcons.map((m) => {
    if (!m) return null;
    return { ...m, x: m.x / upscale, y: m.y / upscale, w: m.w / upscale, h: m.h / upscale };
  });

  const ownsWorker = !externalWorker;
  let worker: any;
  if (externalWorker) {
    worker = externalWorker;
  } else {
    const { createWorker } = await import("tesseract.js");
    worker = await createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "+0123456789",
      tessedit_pageseg_mode: "7" as any,
    });
  }

  const modules: ModuleInput[] = [];
  const rowPositions: RowPosition[] = [];
  let uuidCounter = startUuid;
  const iconH1x = anchor.iconSize;

  try {
    for (let i = 0; i < ocrRows.length; i++) {
      onProgress?.({
        stage: `数値読み取り中... (${i + 1}/${ocrRows.length})`,
        percent: 60 + (i / ocrRows.length) * 35,
      });

      const stats = await ocrNumbersForRow(canvas, ocrRows[i], worker);
      if (stats.length > 0) {
        const modIcon = ocrModuleIcons[i];
        modules.push({
          uuid: uuidCounter++,
          config_id: modIcon?.configId ?? null,
          quality: modIcon?.rarity ?? null,
          stats: stats.map((s) => ({ part_id: s.part_id, value: s.value })),
        });
        const refX = modIcon ? modIcon.x : (ocrRows[i].stats[0]?.x ?? 0) - iconH1x * 2;
        rowPositions.push({
          y: ocrRows[i].y + cropY,
          x: refX + cropX,
          h: iconH1x,
        });
      }
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
    if (ownsWorker) {
      await worker.terminate();
    }
  }

  onProgress?.({ stage: "完了", percent: 100 });
  return { modules, rowPositions };
}

export async function processScreenshot(
  imageSource: HTMLImageElement | HTMLCanvasElement,
  onProgress?: (p: OcrProgress) => void,
  externalWorker?: any,
  customOptions?: OcrCustomOptions,
  startUuid?: number,
): Promise<ProcessScreenshotResult> {
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

  const isCustomMode = !!customOptions?.region;
  const region = customOptions?.region;

  // クロップ: 詳細設定モードはユーザー指定領域、autoモードは左40%
  let cropX: number, cropY: number, cropWidth: number, cropHeight: number;
  if (region) {
    cropX = Math.max(0, Math.round(region.x));
    cropY = Math.max(0, Math.round(region.y));
    cropWidth = Math.min(Math.round(region.width), imgWidth - cropX);
    cropHeight = Math.min(Math.round(region.height), imgHeight - cropY);
  } else {
    cropX = 0;
    cropY = 0;
    cropWidth = Math.round(imgWidth * 0.4);
    cropHeight = imgHeight;
  }

  canvas.width = cropWidth;
  canvas.height = cropHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(imageSource, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

  // 前処理: グレースケール → コントラスト正規化 → エッジ
  const srcMat = cv.imread(canvas);
  const colorMat = srcMat.clone();
  const gray = new cv.Mat();
  cv.cvtColor(srcMat, gray, cv.COLOR_RGBA2GRAY);
  srcMat.delete();

  const grayEq = new cv.Mat();
  cv.equalizeHist(gray, grayEq);
  const edgeMat = new cv.Mat();
  cv.Canny(grayEq, edgeMat, 50, 150);

  // CLAHE前処理（ステータスアイコン分類・モジュールアイコン分類で使用）
  const grayCl = applyCLAHE(gray, cv);
  const edgeCl = new cv.Mat();
  cv.Canny(grayCl, edgeCl, 50, 150);

  // --- 詳細設定モード: グリッド交点ベース検出 ---
  if (isCustomMode) {
    return processCustomMode(
      canvas, gray, grayEq, edgeMat, grayCl, edgeCl, colorMat,
      cropWidth, cropHeight, imgWidth, imgHeight,
      onProgress, externalWorker, customOptions, cv,
      startUuid ?? 1,
    );
  }

  // --- autoモード: 既存パイプライン ---
  // スケール検出（半径推定 + スケール基準用）
  onProgress?.({ stage: "スケール検出中...", percent: 20 });
  const scale = detectScale(gray, cv);
  const moduleScale = scale * 0.65;
  const estimatedRadius = Math.round(40 * scale);
  const lowResInput = canvas.width < 500 || estimatedRadius < 12;
  // HoughCircles用にmedianBlur適用
  const blurred = new cv.Mat();
  cv.medianBlur(gray, blurred, 5);
  gray.delete();

  // HoughCirclesで円候補を検出
  onProgress?.({ stage: "アイコン位置検出中...", percent: 30 });
  const circles = detectCircles(blurred, cv, estimatedRadius);
  blurred.delete();
  let detections: Detection[];

  if (!lowResInput && circles.length >= 3) {
    // グリッドスロット構築
    onProgress?.({ stage: "グリッド解析中...", percent: 40 });
    const slots = buildGridSlots(circles, 3, imgHeight, estimatedRadius);

    if (slots.length > 0) {
      // 局所分類（gray_only方式）
      onProgress?.({ stage: "アイコン分類中...", percent: 50 });
      const classified = classifyAllSlots(grayEq, edgeMat, grayCl, slots, scale, cv);

      if (shouldFallbackToTemplateMatching(slots, classified)) {
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
      detections = matchAllStatIcons(edgeMat, cv, scale);
      const iconSize = Math.round(80 * scale);
      detections = fillGridGaps(detections, edgeMat, cv, scale, iconSize);
    }
  } else {
    // HoughCircles候補不足 → フォールバック（既存テンプレートマッチング方式）
    onProgress?.({ stage: "アイコン検出中（フォールバック）...", percent: 40 });
    detections = matchAllStatIcons(edgeMat, cv, scale);
    const iconSize = Math.round(80 * scale);
    detections = fillGridGaps(detections, edgeMat, cv, scale, iconSize);
  }

  if (detections.length === 0) {
    grayEq.delete();
    edgeMat.delete();
    grayCl.delete();
    edgeCl.delete();
    colorMat.delete();
    // Canvas即時解放
    canvas.width = 0;
    canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }

  // 行グルーピング
  const iconSize = detections[0]?.w || Math.round(80 * scale);
  let rows = groupIntoRows(detections, iconSize);

  // 行間隔の外れ値フィルタ（フォールバックパスでも適用）
  if (rows.length >= 4) {
    const rowYs = rows.map((r) => r.y);
    const filteredYs = filterRowsBySpacing(rowYs);
    if (filteredYs.length < rows.length) {
      const filteredSet = new Set(filteredYs.map((y) => Math.round(y)));
      rows = rows.filter((r) => filteredSet.has(Math.round(r.y)));
    }
  }

  // 行間隔のギャップ補完: 中央値の約2倍の隙間がある場所に空行を挿入
  if (rows.length >= 3) {
    const spacings = rows.slice(1).map((r, i) => r.y - rows[i].y);
    const medSpacing = median(spacings);
    if (medSpacing > 0) {
      const insertions: { index: number; y: number }[] = [];
      for (let i = 0; i < spacings.length; i++) {
        if (spacings[i] > medSpacing * 1.6) {
          const gapCount = Math.round(spacings[i] / medSpacing);
          for (let g = 1; g < gapCount; g++) {
            const insertY = rows[i].y + medSpacing * g;
            insertions.push({ index: i + g, y: insertY });
          }
        }
      }
      if (insertions.length > 0) {
        // テンプレートマッチングで挿入位置のステータスアイコンを検出
        for (const ins of insertions.reverse()) {
          const searchY = Math.max(0, Math.round(ins.y - iconSize * 1.0));
          const searchH = Math.min(iconSize * 3, edgeMat.rows - searchY);
          if (searchH < iconSize) continue;

          const searchRect = new cv.Rect(0, searchY, edgeMat.cols, searchH);
          const searchEdge = edgeMat.roi(searchRect);
          const searchGray = grayEq.roi(searchRect);
          const localDets: Detection[] = [];

          for (const tmpl of statTemplates) {
            const tw = Math.round(tmpl.edgeMat.cols * scale);
            const th = Math.round(tmpl.edgeMat.rows * scale);
            if (tw < 10 || th < 10 || tw >= searchEdge.cols || th >= searchEdge.rows) continue;

            // エッジとグレー両方でマッチング
            const resizedEdge = new cv.Mat();
            cv.resize(tmpl.edgeMat, resizedEdge, new cv.Size(tw, th));
            const edgeResult = new cv.Mat();
            cv.matchTemplate(searchEdge, resizedEdge, edgeResult, cv.TM_CCOEFF_NORMED);
            const edgeLoc = cv.minMaxLoc(edgeResult);

            const resizedGray = new cv.Mat();
            cv.resize(tmpl.grayMat, resizedGray, new cv.Size(tw, th));
            const grayResult = new cv.Mat();
            cv.matchTemplate(searchGray, resizedGray, grayResult, cv.TM_CCOEFF_NORMED);
            const grayLoc = cv.minMaxLoc(grayResult);

            const maxVal = Math.max(edgeLoc.maxVal, grayLoc.maxVal);
            const maxLoc = edgeLoc.maxVal >= grayLoc.maxVal ? edgeLoc.maxLoc : grayLoc.maxLoc;
            resizedEdge.delete(); edgeResult.delete();
            resizedGray.delete(); grayResult.delete();

            if (maxVal >= 0.35) {
              localDets.push({
                partId: tmpl.partId,
                x: maxLoc.x,
                y: searchY + maxLoc.y,
                w: tw,
                h: th,
                score: maxVal,
                margin: 0,
              });
            }
            // resized/result は既にマッチング直後に delete 済み
          }
          searchEdge.delete();
          searchGray.delete();

          if (localDets.length > 0) {
            // NMS: 同じ位置の重複を除去
            localDets.sort((a, b) => b.score - a.score);
            const nmsThreshold = iconSize * 0.5;
            const kept: Detection[] = [];
            for (const det of localDets) {
              const overlap = kept.some(
                (k) => Math.abs(k.x - det.x) < nmsThreshold && Math.abs(k.y - det.y) < nmsThreshold,
              );
              if (!overlap) kept.push(det);
            }

            const best = kept[0];
            const newRow: ModuleRow = {
              y: ins.y,
              stats: kept.slice(0, 3).map((d) => ({
                partId: d.partId,
                x: d.x,
                y: d.y,
                w: d.w,
                h: d.h,
                score: d.score,
                margin: d.margin,
              })),
            };
            newRow.stats.sort((a, b) => a.x - b.x);
            rows.splice(ins.index, 0, newRow);
          } else {
            rows.splice(ins.index, 0, { y: ins.y, stats: [] });
          }
        }
      }
    }
  }

  // モジュールアイコン分類（各行の左側を検索）
  onProgress?.({ stage: "モジュールアイコン検出中...", percent: 55 });
  const moduleIcons: (ModuleIconMatch | null)[] = [];
  for (const row of rows) {
    moduleIcons.push(classifyModuleIconForRow(colorMat, grayEq, edgeMat, grayCl, row, scale, moduleScale, cv));
  }
  // ステータスが4つ以上検出された行はスコア上位3つに絞る
  const anchoredRows = rows.map((row) => {
    if (row.stats.length <= 3) return row;
    const sorted = [...row.stats].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const kept = sorted.slice(0, 3).sort((a, b) => a.x - b.x);
    return { y: row.y, stats: kept };
  });
  grayEq.delete();
  edgeMat.delete();
  grayCl.delete();
  edgeCl.delete();
  colorMat.delete();

  // 数値OCR
  onProgress?.({ stage: "数値読み取り中...", percent: 60 });
  const ownsWorker = !externalWorker;
  let worker: any;
  if (externalWorker) {
    worker = externalWorker;
  } else {
    const { createWorker } = await import("tesseract.js");
    worker = await createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "+0123456789",
      tessedit_pageseg_mode: "7" as any,
    });
  }

  const modules: ModuleInput[] = [];
  const rowPositions: RowPosition[] = [];
  let uuidCounter = startUuid ?? 1;
  const iconH = anchoredRows[0]?.stats[0]?.h ?? Math.round(80 * scale);

  try {
    for (let i = 0; i < anchoredRows.length; i++) {
      onProgress?.({
        stage: `数値読み取り中... (${i + 1}/${anchoredRows.length})`,
        percent: 60 + (i / anchoredRows.length) * 35,
      });

      const stats = await ocrNumbersForRow(canvas, anchoredRows[i], worker) as Array<
        StatEntry & {
          _ocrDebug?: {
            hadPlus: boolean;
            rawText: string;
            normalized: string;
            matchedText: string;
          };
        }
      >;
      if (stats.length > 0) {
        const modIcon = moduleIcons[i];
        modules.push({
          uuid: uuidCounter++,
          config_id: modIcon?.configId ?? null,
          quality: modIcon?.rarity ?? null,
          stats: stats.map((s) => ({ part_id: s.part_id, value: s.value })),
        });
        const refX = modIcon ? modIcon.x : (anchoredRows[i].stats[0]?.x ?? 0) - iconH * 2;
        rowPositions.push({
          y: anchoredRows[i].y,
          x: refX,
          h: iconH,
        });
      }
    }
  } finally {
    // OCR用Canvas即時解放
    canvas.width = 0;
    canvas.height = 0;
    if (ownsWorker) {
      await worker.terminate();
    }
  }

  onProgress?.({ stage: "完了", percent: 100 });
  return { modules, rowPositions };
}
