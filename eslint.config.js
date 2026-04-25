const js = require("@eslint/js");
const tsParser = require("@typescript-eslint/parser");
const tsPlugin = require("@typescript-eslint/eslint-plugin");

module.exports = [
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "tests/**/*.ts", "prisma/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: __dirname
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
        fetch: "readonly",
        require: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        Headers: "readonly",
        RequestInit: "readonly",
        Response: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];
