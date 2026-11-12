import globals from "globals";

const rules = {
  "no-undef": "error",
  "no-dupe-keys": "error",
  "no-dupe-args": "error",
  "no-duplicate-case": "error",
  "no-unreachable": "error",
  "no-constant-condition": "error",
  "no-empty": "error",
  "valid-typeof": "error",
  "no-redeclare": "error",
};

export default [
  // Browser ES modules (app.js and the src/*.js modules it imports)
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        // Chart.js 4.4.1: index.html loads chart.umd.js from jsDelivr.
        Chart: "readonly",
        // Leaflet 1.9.4: index.html loads leaflet.js from unpkg.
        L: "readonly",
      }
    },
    rules,
  },
  // ES module scripts (*.mjs — sync scripts, test runner)
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.node,
      }
    },
    rules,
  },
];
