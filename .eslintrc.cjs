module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint", "react-hooks", "react-refresh"],
  extends: ["eslint:recommended", "plugin:react-hooks/recommended"],
  ignorePatterns: ["dist", "node_modules", "scripts", "test_*.{js,ts}", "list_models.js"],
  settings: {
    react: { version: "detect" },
  },
  rules: {
    "no-undef": "off",
    "no-unused-vars": "off",
    "react-refresh/only-export-components": "off",
    "react-hooks/exhaustive-deps": "off",
  },
};
