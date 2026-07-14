// Machine-checked code standards (docs/standards.md): strict TypeScript
// everywhere, `any` forbidden in core/ — it is the byte-critical library.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/", "**/dist/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["core/src/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
