import { initSync, optimize } from "../pkg/star_optimizer_wasm.js";

let ready = false;

self.onmessage = (e: MessageEvent) => {
  const { type } = e.data;

  if (type === "init") {
    // メインスレッドでコンパイル済みのWebAssembly.Moduleを受け取って初期化
    initSync({ module: e.data.module });
    ready = true;
    // ウォームアップ: 4重ループのホットパスを通るダミーデータで呼び出し、
    // V8のTurboFan最適化コンパイルを事前にトリガーする
    try {
      const dummyModules = [];
      for (let i = 0; i < 10; i++) {
        dummyModules.push({
          uuid: i,
          quality: 5,
          stats: [
            { part_id: 1, value: 5 },
            { part_id: 2, value: 3 },
          ],
        });
      }
      optimize(
        JSON.stringify(dummyModules),
        JSON.stringify({
          required_stats: [1],
          desired_stats: [2],
          excluded_stats: [],
          min_quality: 3,
          speed_mode: "standard",
        }),
      );
    } catch { /* ignore warm-up errors */ }
    return;
  }

  if (type === "optimize") {
    if (!ready) {
      self.postMessage({ type: "error", error: "WASM not initialized" });
      return;
    }
    try {
      const result = optimize(
        JSON.stringify(e.data.modules),
        JSON.stringify(e.data.request),
      );
      self.postMessage({ type: "result", data: JSON.parse(result) });
    } catch (err) {
      self.postMessage({
        type: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
};
