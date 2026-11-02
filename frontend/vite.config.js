import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // strictPort: fail loudly instead of silently moving to 5174 (the launcher expects 5173).
  server: { port: 5173, strictPort: true },
});
