import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Proxy to 127.0.0.1 rather than "localhost", which can resolve to ::1 first and fail. PORT matches the server's PORT.
const apiTarget = `http://127.0.0.1:${process.env.PORT ?? "7487"}`;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Server-Sent Events: http-proxy streams the response as it arrives, so nothing in between buffers it.
      "/api": { target: apiTarget, changeOrigin: false },
    },
  },
});
