import init, { optimize } from "../pkg/star_optimizer_wasm.js";

let ready = false;

async function ensureInit() {
  if (!ready) {
    await init();
    ready = true;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const { type, modules, request } = e.data;
  if (type === "optimize") {
    try {
      await ensureInit();
      const result = optimize(
        JSON.stringify(modules),
        JSON.stringify(request),
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
