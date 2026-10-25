import { defineConfig, searchForWorkspaceRoot } from "vite";

export default defineConfig({
  // Relative paths so the build works from GitHub Pages or any subdirectory.
  base: "./",
  build: {
    // three.js alone is bigger than the default warning limit.
    chunkSizeWarningLimit: 1000,
    rolldownOptions: {
      output: {
        // The Visual Editor writes TypeScript that names each component's class (the "Sync diffs"
        // file, and properties/*.txt).  Without this, minifying turns those names into "hi" and "Nr".
        keepNames: true,
      },
    },
  },
  server: {
    // Always the same port.  The video editor saves its work in the browser (IndexedDB),
    // and the browser keeps a separate copy for each port.  If Vite moved to a different
    // port because another project was using this one, the editor would seem to forget everything.
    // canvas-recorder uses 5173.
    port: 5174,
    strictPort: true,
    fs: {
      // canvas-recorder-lib is linked from ../canvas-recorder-lib (a "file:" dependency in package.json),
      // so it lives outside this project.  Vite serves anything that's imported, but its web worker
      // is loaded by URL, so the folder has to be allowed explicitly.
      // Setting this turns off Vite's default, so this project's own folder has to be listed too.
      allow: [searchForWorkspaceRoot(process.cwd()), "../canvas-recorder-lib"],
    },
  },
});
