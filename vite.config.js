import fs from "node:fs";
import { defineConfig } from "vite";

function buildHttpsOptions() {
  if (process.env.DEV_HTTPS !== "1") {
    return undefined;
  }

  const certFile = process.env.DEV_CERT_FILE;
  const keyFile = process.env.DEV_KEY_FILE;

  if (!certFile || !keyFile) {
    throw new Error("DEV_HTTPS is enabled but DEV_CERT_FILE or DEV_KEY_FILE is missing.");
  }

  return {
    cert: fs.readFileSync(certFile),
    key: fs.readFileSync(keyFile),
  };
}

const bridgeProxyTarget = process.env.DEV_BRIDGE_PROXY_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
  server: {
    host: process.env.DEV_HTTPS === "1" ? "0.0.0.0" : undefined,
    https: buildHttpsOptions(),
    proxy: {
      "/bridge": {
        target: bridgeProxyTarget,
        changeOrigin: true,
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/bridge/, ""),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three/examples/jsm/")) {
            return "three-examples";
          }

          if (id.includes("node_modules/three/")) {
            return "three-core";
          }

          if (id.includes("node_modules/")) {
            return "vendor";
          }

          return undefined;
        },
      },
    },
  },
});
