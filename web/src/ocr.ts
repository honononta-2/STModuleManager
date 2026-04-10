import { STAT_ICONS, MODULE_ICONS } from "@shared/stats";
import type { ModuleInput, StatEntry } from "@shared/types";

export interface OcrCustomOptions {
  platform: "mobile" | "pc";
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


// --- 共通型定義 ---

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


// ステータスアイコン分類（予測座標指定・最小探索範囲版）
function classifyStatAtPoint(
  colorMat: any,
  cx: number,
  cy: number,
  iconSide: number,
  cv: any,
  excludePids?: Set<number>,
): { pid: number; score: number; margin: number } {
  const pad = 4;
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

// モジュールアイコン分類（予測座標指定・最小探索範囲版）
// 位置が確定している場合用: パディングを最小にしてmatchTemplateの探索範囲を極小化
function classifyModuleIconAtPoint(
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

  // 最小パディング: 位置が予測済みなので探索範囲を数ピクセルに限定
  const pad = 4;
  const roiX = Math.max(0, Math.round(cx - expectedW / 2 - pad));
  const roiY = Math.max(0, Math.round(cy - expectedH / 2 - pad));
  const roiW = Math.min(expectedW + pad * 2, colorMat.cols - roiX);
  const roiH = Math.min(expectedH + pad * 2, colorMat.rows - roiY);
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

// ========== 予測グリッドパイプライン（auto内部で使用） ==========

interface PredictedGrid {
  base: number;
  scale: number;
  iconSize: number;
  colXs: number[];
  moduleIconX: number;
  yMin: number;
  yMax: number;
  platform: "pc" | "mobile";
  mobileLayout?: "phone" | "ipad"; // モバイルのレイアウト種別
}

// 画像サイズからグリッドパラメータを計算（テンプレートマッチング不要）
function predictGridFromImageSize(
  imgWidth: number,
  imgHeight: number,
  platform: "pc" | "mobile",
  mobileLayout?: "phone" | "ipad",
): PredictedGrid {
  if (platform === "pc") {
    const base = Math.min(imgWidth, imgHeight * 16 / 9);
    const scale = base / 5780;
    const iconSize = Math.round(80 * scale);
    const COL_RATIOS = [0.084, 0.122, 0.159];
    const colXs = COL_RATIOS.map(r => Math.round(base * r));
    const moduleIconX = Math.round(base * 0.0557);
    const yMin = Math.round(base * 0.08);
    const yMax = Math.round(imgHeight - base * 0.065);
    return { base, scale, iconSize, colXs, moduleIconX, yMin, yMax, platform };
  }

  // モバイル版: base = sqrt(W × H)
  const base = Math.sqrt(imgWidth * imgHeight);
  const scale = base / 3470;
  const iconSize = Math.round(80 * scale);
  const gap = base * 0.0592;
  const layout = mobileLayout ?? "phone";
  // スマホ: col1 = base × 0.1846, iPad: col1 = base × 0.117
  const col1Ratio = layout === "phone" ? 0.1846 : 0.117;
  const col1 = Math.round(base * col1Ratio);
  const colXs = [col1, Math.round(col1 + gap), Math.round(col1 + gap * 2)];
  // モジュールアイコン: min(W, H*16/9)基準で0.0557（PC版と同じbase定義）
  const moduleIconX = Math.round(Math.min(imgWidth, imgHeight * 16 / 9) * 0.0557);
  // ヘッダー〜リスト間の隙間による誤検出を防ぐため、imgH * 0.16 を下限に設定
  const yMin = Math.max(Math.round(base * 0.06), Math.round(imgHeight * 0.16));
  const yMax = Math.round(imgHeight - base * 0.05);
  return { base, scale, iconSize, colXs, moduleIconX, yMin, yMax, platform, mobileLayout: layout };
}

// Y範囲制限つき行検出（予測グリッドモード用）
function predictedGridDetectRows(
  grayEq: any,
  colXs: number[],
  iconSize: number,
  scale: number,
  yMin: number,
  yMax: number,
  cv: any,
): { y: number; score: number }[] {
  if (colXs.length === 0) return [];

  // Y範囲でROIを切り出し（下端のみマージン付き）
  const roiY0 = yMin;
  const roiY1 = Math.min(grayEq.rows, yMax + iconSize);
  const roiH = roiY1 - roiY0;
  if (roiH < iconSize * 2) return [];

  const yRoi = grayEq.roi(new cv.Rect(0, roiY0, grayEq.cols, roiH));
  const result = new cv.Mat();
  const yScores = new Float64Array(roiH);
  const refs = statTemplates;
  const halfIcon = Math.round(iconSize / 2);

  for (const cx of colXs) {
    const colRoiX = Math.max(0, Math.round(cx - halfIcon - 5));
    const colRoiW = Math.min(iconSize + 10, yRoi.cols - colRoiX);
    if (colRoiW < iconSize) continue;
    const roi = yRoi.roi(new cv.Rect(colRoiX, 0, colRoiW, roiH));

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
  yRoi.delete();
  result.delete();

  // ピーク検出（ROIオフセットを補正して絶対座標に変換）
  const minDist = Math.round(iconSize * 1.5);
  const peaks: { y: number; score: number }[] = [];
  for (let y = 0; y < yScores.length; y++) {
    if (yScores[y] < 0.3) continue;
    let isPeak = true;
    for (let dy = -minDist; dy <= minDist; dy++) {
      const ny = y + dy;
      if (ny >= 0 && ny < yScores.length && ny !== y && yScores[ny] > yScores[y]) {
        isPeak = false;
        break;
      }
    }
    if (isPeak) {
      const absY = y + roiY0 + iconSize / 2;
      if (absY >= yMin && absY <= yMax) {
        peaks.push({ y: absY, score: yScores[y] });
      }
    }
  }

  // 等間隔フィルタ
  const sorted = peaks.sort((a, b) => a.y - b.y);
  if (sorted.length >= 3) {
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i].y - sorted[i - 1].y);
    const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
    return sorted
      .filter((_, i) => {
        if (i === 0) return true;
        const gap = sorted[i].y - sorted[i - 1].y;
        return Math.abs(gap - medGap) / medGap < 0.3 || gap > medGap * 1.5;
      });
  }
  return sorted;
}

// --- モバイルautoモード用: アイコン検出ベースのグリッド構築 ---

interface IconHit { x: number; y: number; score: number }

/**
 * 左側ROI（左3%〜30%）でステータスアイコンをテンプレートマッチング検出。
 * NMS後のヒット座標リストを返す。
 */
function detectIconsInLeftRegion(
  grayEq: any,
  scale: number,
  iconSize: number,
  cv: any,
): IconHit[] {
  const imgW = grayEq.cols;
  const imgH = grayEq.rows;
  const pcBase = Math.min(imgW, imgH * 16 / 9);
  const leftStart = Math.round(pcBase * 0.03);
  const leftEdge = Math.round(pcBase * 0.30);
  const roiW = leftEdge - leftStart;
  const topCut = Math.round(pcBase * 0.075);
  const bottomCut = Math.round(pcBase * 0.080);
  const roiH = imgH - topCut - bottomCut;
  if (roiH < iconSize * 2 || roiW < iconSize) return [];

  const roiLeft = grayEq.roi(new cv.Rect(leftStart, topCut, roiW, roiH));
  const result = new cv.Mat();
  const hits: IconHit[] = [];

  // 最初の8テンプレート × 各背景バリアントでマッチ
  const refs = statTemplates.slice(0, 8);
  for (const ref of refs) {
    const allMats = [ref.grayMat, ...ref.classifyVariants.map((v: any) => v.grayMat)];
    for (const tmplMat of allMats) {
      const tw = Math.round(tmplMat.cols * scale);
      const th = Math.round(tmplMat.rows * scale);
      if (tw >= roiLeft.cols || th >= roiLeft.rows || tw < 10 || th < 10) continue;
      const resized = new cv.Mat();
      cv.resize(tmplMat, resized, new cv.Size(tw, th));
      cv.matchTemplate(roiLeft, resized, result, cv.TM_CCOEFF_NORMED);
      for (let y = 0; y < result.rows; y++) {
        for (let x = 0; x < result.cols; x++) {
          const s = result.floatAt(y, x);
          if (s >= 0.50) {
            hits.push({ x: x + tw / 2 + leftStart, y: y + th / 2 + topCut, score: s });
          }
        }
      }
      resized.delete();
    }
  }
  roiLeft.delete();
  result.delete();

  // NMS: スコア順にソートし、近すぎるヒットを除去
  hits.sort((a, b) => b.score - a.score);
  const kept: IconHit[] = [];
  const minDist = iconSize * 0.5;
  for (const h of hits) {
    if (kept.some(k => Math.abs(k.x - h.x) < minDist && Math.abs(k.y - h.y) < minDist)) continue;
    kept.push(h);
    if (kept.length >= 50) break;
  }
  return kept;
}

/**
 * ヒット座標から列位置を推定（最大3列）。
 * expectedGap（pcBase×0.049）を基準に列インデックスを割り当て、
 * ヒット2個以上の列のみ有効とする。
 */
function deriveColumnsFromHits(
  hits: IconHit[],
  iconSize: number,
  imgW: number,
  imgH: number,
): { colXs: number[]; gap: number } | null {
  if (hits.length < 1) return null;

  const pcBase = Math.min(imgW, imgH * 16 / 9);
  const expectedGap = pcBase * 0.049;

  // 最高スコアのヒットを基準に、各ヒットの列インデックスを割り当て
  const ref = hits[0]; // スコア順ソート済み
  const colGroups = new Map<number, number[]>();
  for (const h of hits) {
    const colIdx = Math.round((h.x - ref.x) / expectedGap);
    if (!colGroups.has(colIdx)) colGroups.set(colIdx, []);
    colGroups.get(colIdx)!.push(h.x);
  }

  // ヒット2個以上 & 期待位置からのズレが小さい列のみ有効
  const validCols: { idx: number; x: number; count: number }[] = [];
  for (const [idx, xs] of colGroups) {
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const medianX = xs[Math.floor(xs.length / 2)];
    const expectedX = ref.x + idx * expectedGap;
    const deviation = Math.abs(medianX - expectedX);
    if (deviation > expectedGap * 0.15) continue;
    validCols.push({ idx, x: medianX, count: xs.length });
  }
  if (validCols.length === 0) return null;

  // インデックス順にソート
  validCols.sort((a, b) => a.idx - b.idx);

  // 連続する最大3列の区間を選ぶ（ヒット数合計が最大の区間）
  let bestStart = 0;
  let bestCount = 0;
  for (let s = 0; s < validCols.length; s++) {
    let end = s;
    while (end + 1 < validCols.length &&
           validCols[end + 1].idx - validCols[end].idx === 1 &&
           end - s + 1 < 3) {
      end++;
    }
    const total = validCols.slice(s, end + 1).reduce((a, c) => a + c.count, 0);
    if (total > bestCount) {
      bestCount = total;
      bestStart = s;
    }
  }

  const selected = validCols.slice(bestStart, bestStart + 3)
    .filter((c, i, arr) => i === 0 || c.idx - arr[i - 1].idx === 1);
  const colXs = selected.map(c => c.x);

  return { colXs, gap: expectedGap };
}

// 予測グリッドモードのメインパイプライン
async function processPredictedGridMode(
  canvas: HTMLCanvasElement,
  gray: any,
  grayEq1x: any,
  _grayCl1x: any, // 未使用（CLAHE不要）、呼び出し元との互換性のため保持
  colorMat1x: any,
  cropWidth: number,
  cropHeight: number,
  imgWidth: number,
  imgHeight: number,
  predicted: PredictedGrid,
  onProgress: ((p: OcrProgress) => void) | undefined,
  externalWorker: any,
  customOptions: OcrCustomOptions | undefined,
  cv: any,
  startUuid: number,
): Promise<ProcessScreenshotResult> {
  const { scale, iconSize, colXs, yMin, yMax } = predicted;

  console.log(`[predictedGrid] base=${predicted.base.toFixed(0)} scale=${scale.toFixed(4)} icon=${iconSize}`);
  console.log(`[predictedGrid] colXs=[${colXs.join(",")}] yRange=${yMin}〜${yMax}`);
  const _t: Record<string, number> = {};
  const _tick = (label: string) => { _t[label] = performance.now(); };
  _tick("start");

  // Step 1: 行検出（Y範囲制限つき、列位置は計算済み）
  onProgress?.({ stage: "行検出中（予測グリッド）...", percent: 25 });
  const rowYs = predictedGridDetectRows(grayEq1x, colXs, iconSize, scale, yMin, yMax, cv).map(r => r.y);
  _tick("rowDetect");
  if (rowYs.length === 0) {
    console.warn("[predictedGrid] 行検出失敗");
    gray.delete(); grayEq1x.delete(); _grayCl1x.delete(); colorMat1x.delete();
    canvas.width = 0; canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }
  console.log(`[predictedGrid] ${rowYs.length}行検出`);

  // Step 2: アップスケール
  const upscale = Math.max(2, Math.round(50 / iconSize));
  const grayUpscaled = new cv.Mat();
  cv.resize(gray, grayUpscaled, new cv.Size(0, 0), upscale, upscale, cv.INTER_CUBIC);
  gray.delete();

  grayUpscaled.delete();

  const scaledColXs = colXs.map((x) => x * upscale);
  const scaledRowYs = rowYs.map((y) => y * upscale);
  const scaledIconSize = Math.round(iconSize * upscale);
  const scaledScale = scale * upscale;

  // カラー画像をアップスケール
  const colorMatUp = new cv.Mat();
  cv.resize(colorMat1x, colorMatUp, new cv.Size(0, 0), upscale, upscale, cv.INTER_CUBIC);

  // 1x画像は不要なので解放
  grayEq1x.delete();
  _grayCl1x.delete();
  _tick("upscale");

  // Step 3: ステータス分類（カラーマッチング）
  onProgress?.({ stage: "ステータスアイコン分類中...", percent: 45 });
  const rows: ModuleRow[] = [];
  const STAT_ABSENT_THRESHOLD = 0.55;

  for (let ri = 0; ri < scaledRowYs.length; ri++) {
    const ry = scaledRowYs[ri];
    const stats: ModuleRow["stats"] = [];

    for (let ci = 0; ci < scaledColXs.length; ci++) {
      const cx = scaledColXs[ci];
      const excludePids = ci >= 1 ? EXTREME_STAT_PIDS : undefined;

      // カラーマッチング（予測座標・最小探索版）
      const result = classifyStatAtPoint(colorMatUp, cx, ry, scaledIconSize, cv, excludePids);

      // ステータスなし判定: 閾値未満ならスキップ（青=1ステ、紫=2ステ対応）
      if (result.score < STAT_ABSENT_THRESHOLD) {
        await new Promise<void>((r) => setTimeout(r, 0));
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
      await new Promise<void>((r) => setTimeout(r, 0));
    }

    rows.push({ y: ry, stats });
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  _tick("statClassify");

  // Step 4: モジュールアイコン分類（予測座標で最小探索 → スコア低時のみ広域フォールバック）
  onProgress?.({ stage: "モジュールアイコン検出中...", percent: 55 });
  const moduleScale = scaledScale * 0.675;
  const predictedModuleX = predicted.moduleIconX * upscale;
  const MODULE_ICON_RETRY_THRESHOLD = 0.70;

  const moduleIcons: (ModuleIconMatch | null)[] = [];
  for (let ri = 0; ri < scaledRowYs.length; ri++) {
    // Step4-1: 予測位置で最小探索（pad=4px、高速）
    let result = classifyModuleIconAtPoint(
      colorMatUp, predictedModuleX, scaledRowYs[ri],
      moduleScale, cv,
    );

    // Step4-2: スコアが低い場合、広域探索にフォールバック
    if (!result || result.score < MODULE_ICON_RETRY_THRESHOLD) {
      const widerResult = classifyModuleIconByColor(
        colorMatUp, predictedModuleX, scaledRowYs[ri],
        moduleScale, cv,
      );
      if (widerResult && (!result || widerResult.score > result.score)) {
        result = widerResult;
      }
    }

    moduleIcons.push(result);
    await new Promise((r) => setTimeout(r, 0));
  }
  _tick("moduleIcon");

  colorMatUp.delete();
  colorMat1x.delete();

  // ステータスが4つ以上検出された行はスコア上位3つに絞る
  const anchoredRows = rows.map((row) => {
    if (row.stats.length <= 3) return row;
    const sorted = [...row.stats].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const kept = sorted.slice(0, 3).sort((a, b) => a.x - b.x);
    return { y: row.y, stats: kept };
  });

  // Step 5: 数値OCR
  onProgress?.({ stage: "数値読み取り中...", percent: 60 });
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
        const refX = modIcon ? modIcon.x : (ocrRows[i].stats[0]?.x ?? 0) - iconSize * 2;
        rowPositions.push({
          y: ocrRows[i].y,
          x: refX,
          h: iconSize,
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

  _tick("ocr");

  // 計測ログ出力
  const _keys = Object.keys(_t);
  const _lines: string[] = [];
  for (let i = 1; i < _keys.length; i++) {
    _lines.push(`  ${_keys[i]}: ${(_t[_keys[i]] - _t[_keys[i - 1]]).toFixed(0)}ms`);
  }
  _lines.push(`  合計: ${(_t[_keys[_keys.length - 1]] - _t[_keys[0]]).toFixed(0)}ms`);
  console.log(`[predictedGrid] 処理時間:\n${_lines.join("\n")}`);

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

  // クロップ幅を計算してcanvas作成するヘルパー（予測グリッドパイプライン共通）
  const preparePredictedCanvas = (predicted: PredictedGrid) => {
    // 数値OCR用に必要な右端 = 3列目 + iconSize*2.5 + マージン
    const rightEdge = predicted.colXs[predicted.colXs.length - 1] + predicted.iconSize * 3;
    const predictedCropWidth = Math.min(Math.round(rightEdge), imgWidth);
    canvas.width = predictedCropWidth;
    canvas.height = imgHeight;
    const pCtx = canvas.getContext("2d")!;
    pCtx.drawImage(imageSource, 0, 0, predictedCropWidth, imgHeight, 0, 0, predictedCropWidth, imgHeight);

    const pSrcMat = cv.imread(canvas);
    const pColorMat = pSrcMat.clone();
    const pGray = new cv.Mat();
    cv.cvtColor(pSrcMat, pGray, cv.COLOR_RGBA2GRAY);
    pSrcMat.delete();
    const pGrayEq = new cv.Mat();
    cv.equalizeHist(pGray, pGrayEq);
    return { pGray, pGrayEq, pColorMat, predictedCropWidth };
  };

  // --- autoモード + PC: 予測グリッドパイプラインを使用 ---
  if (customOptions?.platform === "pc") {
    const predicted = predictGridFromImageSize(imgWidth, imgHeight, "pc");
    const { pGray, pGrayEq, pColorMat, predictedCropWidth } = preparePredictedCanvas(predicted);
    const pGrayCl = new cv.Mat();
    return processPredictedGridMode(
      canvas, pGray, pGrayEq, pGrayCl, pColorMat,
      predictedCropWidth, imgHeight, imgWidth, imgHeight,
      predicted,
      onProgress, externalWorker, customOptions, cv,
      startUuid ?? 1,
    );
  }

  // --- autoモード + モバイル: アイコン検出ベースパイプライン ---
  {
    onProgress?.({ stage: "アイコン検出中...", percent: 15 });

    // フルサイズ画像からgrayEqを作成してアイコン検出
    const detectCanvas = document.createElement("canvas");
    detectCanvas.width = imgWidth;
    detectCanvas.height = imgHeight;
    const detectCtx = detectCanvas.getContext("2d")!;
    detectCtx.drawImage(imageSource, 0, 0);
    const detectSrc = cv.imread(detectCanvas);
    const detectGray = new cv.Mat();
    cv.cvtColor(detectSrc, detectGray, cv.COLOR_RGBA2GRAY);
    detectSrc.delete();
    const detectGrayEq = new cv.Mat();
    cv.equalizeHist(detectGray, detectGrayEq);
    detectGray.delete();
    detectCanvas.width = 0;
    detectCanvas.height = 0;

    const mobileScale = Math.sqrt(imgWidth * imgHeight) / 3470;
    const mobileIconSize = Math.round(80 * mobileScale);

    const iconHits = detectIconsInLeftRegion(detectGrayEq, mobileScale, mobileIconSize, cv);
    const colResult = deriveColumnsFromHits(iconHits, mobileIconSize, imgWidth, imgHeight);
    detectGrayEq.delete();

    if (colResult && colResult.colXs.length >= 1) {
      const { colXs, gap } = colResult;
      const pcBase = Math.min(imgWidth, imgHeight * 16 / 9);
      const moduleIconX = Math.round(colXs[0] - gap * 0.80);
      const yMin = Math.round(pcBase * 0.075);
      const yMax = Math.round(imgHeight - pcBase * 0.080);

      const predicted: PredictedGrid = {
        base: pcBase,
        scale: mobileScale,
        iconSize: mobileIconSize,
        colXs,
        moduleIconX,
        yMin,
        yMax,
        platform: "mobile",
      };

      console.log(`[mobileAuto] アイコン検出: ${iconHits.length}ヒット, ${colXs.length}列 [${colXs.map(x => x.toFixed(0)).join(",")}] gap=${gap.toFixed(1)} moduleX=${moduleIconX}`);

      const { pGray, pGrayEq, pColorMat, predictedCropWidth } = preparePredictedCanvas(predicted);
      const pGrayCl = new cv.Mat();
      return processPredictedGridMode(
        canvas, pGray, pGrayEq, pGrayCl, pColorMat,
        predictedCropWidth, imgHeight, imgWidth, imgHeight,
        predicted,
        onProgress, externalWorker, customOptions, cv,
        startUuid ?? 1,
      );
    }

    // アイコン検出失敗 → 空結果を返す
    console.warn(`[mobileAuto] アイコン検出失敗（${iconHits.length}ヒット）`);
    canvas.width = 0; canvas.height = 0;
    return { modules: [], rowPositions: [] };
  }
}
