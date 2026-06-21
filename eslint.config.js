import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["coverage/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "vitest.config.ts"],
    extends: [
      ...tseslint.configs.strictTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "tests/cli/*.ts",
            "tests/companies-house/*.ts",
            "tests/app/*.ts",
            "tests/config/*.ts",
            "tests/contracts/*.ts",
            "tests/doctor/*.ts",
            "tests/examples/*.ts",
            "tests/helpers/*.ts",
            "tests/mcp/*.ts",
            "tests/renderers/*.ts",
            "tests/scripts/*.ts",
            "tests/snapshots/*.ts",
            "vitest.config.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 25,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
