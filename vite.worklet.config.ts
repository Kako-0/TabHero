import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// AudioWorklet: um único arquivo autocontido (sem imports nem chunks), carregado por URL.
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "public", // copiado para dist/ pelo build principal
    emptyOutDir: false,
    lib: {
      entry: "src/worklet/analyzer.worklet.ts",
      formats: ["iife"],
      name: "TabHeroAnalyzer",
      fileName: () => "analyzer.worklet.js",
    },
    target: "es2022",
    minify: true,
  },
});
