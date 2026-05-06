import path from "node:path"
import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

// Frappe serves <app>/<app>/public/ at /assets/<app>/, so the bundle
// emitted to ../upande_scp/public/dist/ is reachable at /assets/upande_scp/dist/.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  // Bench webserver_port is 8001 in this bench (see sites/common_site_config.json).
  // Override with VITE_FRAPPE_URL to point at a specific site, e.g. http://mona.local:8001.
  const frappeUrl = env.VITE_FRAPPE_URL || "http://localhost:8001"

  return {
    base: "/assets/upande_scp/dist/",
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        "/api": { target: frappeUrl, changeOrigin: true },
        "/method": { target: frappeUrl, changeOrigin: true },
        "/assets": { target: frappeUrl, changeOrigin: true },
        "/files": { target: frappeUrl, changeOrigin: true },
        "/private": { target: frappeUrl, changeOrigin: true },
      },
    },
    build: {
      outDir: path.resolve(__dirname, "../upande_scp/public/dist"),
      emptyOutDir: true,
      cssCodeSplit: false,
      manifest: true,
      rollupOptions: {
        output: {
          entryFileNames: "scp.js",
          chunkFileNames: "chunks/[name]-[hash].js",
          assetFileNames: (info) => {
            if (info.name?.endsWith(".css")) return "scp.css"
            return "assets/[name]-[hash][extname]"
          },
        },
      },
    },
  }
})
