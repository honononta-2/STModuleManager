import { processScreenshot, createOcrWorker, type OcrCustomOptions } from "./ocr";

// ワーカーごとに1つのtesseractワーカーを保持して使い回す
let tessWorker: any = null;

interface ProcessMessage {
  type: "process";
  index: number;
  image: ImageBitmap;
  customOptions: OcrCustomOptions;
}

self.onmessage = async (e: MessageEvent<ProcessMessage>) => {
  if (e.data.type !== "process") return;
  const { index, image, customOptions } = e.data;

  try {
    if (!tessWorker) tessWorker = await createOcrWorker();
    // UUIDは全画像の処理完了後にメイン側で振り直すため、ここでは仮値を渡す
    const result = await processScreenshot(image, undefined, tessWorker, customOptions, 1);
    image.close();
    self.postMessage({
      type: "result",
      index,
      modules: result.modules,
      rowPositions: result.rowPositions,
      mobileCols: result.mobileCols ?? null,
    });
  } catch (err) {
    image.close();
    self.postMessage({
      type: "error",
      index,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
