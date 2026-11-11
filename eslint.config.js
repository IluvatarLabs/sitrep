import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// typescript-eslint's recommended rules only; the type-checked presets are left out. The Claude mod in
// mod/ is typechecked separately against Claude Code's declarations.
export default defineConfig(
  globalIgnores(["**/dist/", "**/node_modules/", "mod/", "docs/"]),
  tseslint.configs.recommended,
);
