import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist", "coverage"]),
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["*.mjs", "scripts/*.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["test/**"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
    },
  },
  {
    files: ["test/**/*.test-d.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
    },
  },
  {
    files: ["**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
