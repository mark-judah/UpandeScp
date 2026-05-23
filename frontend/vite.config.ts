// defineConfig is imported from "vitest/config" so the `test` block below
// is typed correctly. vitest/config re-exports vite's defineConfig with the
// extra `test` field on UserConfig.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const FRAPPE_URL = process.env.VITE_FRAPPE_URL || "http://localhost:8001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      // Canonical assets shared with the Python app (e.g. the label
      // tier table both this preview and the PDF renderer read).
      "@shared": path.resolve(__dirname, "../upande_scp/shared"),
    },
  },
  base: "/assets/upande_scp/dist/",
  build: {
    outDir: "../upande_scp/public/dist",
    emptyOutDir: true,
    manifest: true,
    cssCodeSplit: false,
    rollupOptions: {
      output: {
        entryFileNames: "scp-[hash].js",
        assetFileNames: (assetInfo) => {
          const name = assetInfo.name || "";
          if (name.endsWith(".css")) return "scp-[hash].css";
          return "assets/[name]-[hash][extname]";
        },
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: FRAPPE_URL, changeOrigin: true },
      "/method": { target: FRAPPE_URL, changeOrigin: true },
      "/assets": { target: FRAPPE_URL, changeOrigin: true },
      "/files": { target: FRAPPE_URL, changeOrigin: true },
      "/private": { target: FRAPPE_URL, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
  },
});
