import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const FRAPPE_URL = process.env.VITE_FRAPPE_URL || "http://localhost:8001";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
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
});
