import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Resolve the project's "@/*" → "src/*" path alias (mirrors tsconfig paths) so
// unit tests can import modules that reference shared server/lib code.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
