import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import path from "path";

export default defineConfig({
  plugins: [wasm()],
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  worker: {
    plugins: () => [wasm()],
    format: "es",
  },
});
