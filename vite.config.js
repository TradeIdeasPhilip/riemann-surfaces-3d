import { defineConfig } from "vite";

export default defineConfig({
  // Relative paths so the build works from GitHub Pages or any subdirectory.
  base: "./",
  // three.js alone is bigger than the default warning limit.
  build: { chunkSizeWarningLimit: 1000 },
});
