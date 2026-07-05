import { defineConfig } from "vite";

// Relative base so the same build works at any mount point —
// GitHub Pages serves from https://<user>.github.io/<repo>/.
export default defineConfig({
  base: "./"
});
