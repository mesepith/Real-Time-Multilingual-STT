import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7058,
    strictPort: true,
    proxy: {
      "/api": "http://localhost:7059",
    },
  },
  build: {
    outDir: "build", // you said you typically deploy a "build" folder
  },
});
