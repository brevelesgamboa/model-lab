import globals from "globals";

export default [
  {
    ignores: [
      "assets/vendor/**",
      "dist/**",
      "node_modules/**",
      "assets/js/models/classic-dog-dream.js",
    ],
  },
  {
    files: ["assets/js/**/*.js", "prototypes/neural-growth/training/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: globals.browser,
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-unreachable": "error",
      "no-duplicate-imports": "error",
    },
  },
  {
    files: ["tools/**/*.mjs", "tests/**/*.mjs", "*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
];
