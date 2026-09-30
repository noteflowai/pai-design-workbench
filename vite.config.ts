import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({ plugins: [react()], root: "web", build: { outDir: "../web-dist", emptyOutDir: true,
  // three.js lives only in the lazily loaded viewport chunk (~163 kB gzip); the initial shell stays small.
  chunkSizeWarningLimit: 700 } });
