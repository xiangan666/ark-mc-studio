import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["zod", "yauzl"] },
      rollupOptions: { input: resolve("src/main/index.ts") },
    },
  },
  preload: {
    build: { rollupOptions: { input: resolve("src/preload/index.ts") } },
  },
  renderer: {
    root: "src/renderer",
    plugins: [react(), tailwindcss()],
    build: { rollupOptions: { input: resolve("src/renderer/index.html") } },
  },
});
