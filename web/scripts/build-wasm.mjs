// SIMD有効版と非SIMD版の2つのWASMをビルドする
// 非SIMD版を pkg/、SIMD版を pkg-simd/ に出力する
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function runWasmPack(outDir, extraEnv) {
  const args = ["build", "wasm", "--target", "web", "--out-dir", `../${outDir}`];
  const result = spawnSync("wasm-pack", args, {
    cwd: webDir,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv },
  });
  if (result.error) {
    console.error(`wasm-pack の起動に失敗しました: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runWasmPack("pkg", {});
runWasmPack("pkg-simd", { RUSTFLAGS: "-C target-feature=+simd128" });
