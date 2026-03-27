import { defineConfig } from "vite";

export default defineConfig({
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
