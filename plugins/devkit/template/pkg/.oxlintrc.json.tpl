{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": [],
  "categories": {
    "correctness": "off"
  },
  "env": {
    "builtin": true
  },
  "options": {
    "typeAware": true
  },
  "ignorePatterns": [
    "**/node_modules/**",
    "**/*.js",
    "**/*.mjs",
    "**/*.config.ts",
    "dist/**"
  ],
  "overrides": [
    {
      "files": [
        "**/*.{ts,tsx}"
      ],
      "rules": {
        "no-unused-vars": [
          "error",
          {
            "argsIgnorePattern": "^_",
            "varsIgnorePattern": "^_",
            "caughtErrorsIgnorePattern": "^_"
          }
        ],
        "typescript/await-thenable": "error",
        "typescript/no-array-delete": "error",
        "typescript/no-floating-promises": "error",
        "typescript/no-for-in-array": "error",
        "typescript/no-implied-eval": "error",
        "typescript/no-misused-promises": "error",
        "typescript/no-unsafe-argument": "error",
        "typescript/no-unsafe-assignment": "error",
        "typescript/no-unsafe-call": "error",
        "typescript/no-unsafe-declaration-merging": "error",
        "typescript/no-unsafe-enum-comparison": "error",
        "typescript/no-unsafe-function-type": "error",
        "typescript/no-unsafe-member-access": "error",
        "typescript/no-unsafe-return": "error",
        "typescript/no-unsafe-unary-minus": "error"
      },
      "plugins": [
        "typescript"
      ]
    }
  ]
}
