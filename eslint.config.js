// ESLint: correctness rules only. Formatting belongs to Prettier.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "artifacts", "paper", "cuda"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Arithmetic-heavy code: `${number}` in a log line is fine.
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // Unused parameters are allowed when they document an interface.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Config files are plain JS outside the TypeScript project.
    files: ["*.config.js"],
    ...tseslint.configs.disableTypeChecked,
  },
);
