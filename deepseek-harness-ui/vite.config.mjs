import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const harnessProxy = {
  target: "http://127.0.0.1:3080",
  changeOrigin: true,
  rewrite: (path) => path.replace(/^\/harness-api/, "/api"),
  configure(proxy) {
    proxy.on("proxyReq", (proxyRequest) => {
      proxyRequest.setHeader("origin", "http://127.0.0.1:3080");
    });
  },
};

export default defineConfig({
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
    proxy: {
      "/api": harnessProxy,
      "/loom": harnessProxy,
      "/harness-api": harnessProxy,
    },
  },
  preview: {
    proxy: {
      "/api": harnessProxy,
      "/loom": harnessProxy,
      "/harness-api": harnessProxy,
    },
  },
  plugins: [react()],
});
