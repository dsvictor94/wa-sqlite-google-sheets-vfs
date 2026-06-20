import { defineConfig } from "vite";

export default defineConfig({
  base: "/wa-sqlite-google-sheets-vfs/",
  build: {
    outDir: "demo/dist",
    emptyOutDir: true,
  },
});
