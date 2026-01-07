import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 7058,
    proxy: {
      "/api": {
        target: "http://localhost:7059",
        changeOrigin: true
      },
      "/ws": {
        target: "ws://localhost:7059",
        ws: true
      }
    }
  }
});
