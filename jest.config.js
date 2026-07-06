/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/**/*.test.ts",
    "<rootDir>/tests/**/*.test.ts",
  ],
  moduleFileExtensions: ["ts", "js", "json"],
  // Make `import * as os from "os"` spyable (jest.spyOn(os, "homedir")) under
  // esModuleInterop — see tests/helpers/os-shim.js for the full rationale.
  moduleNameMapper: {
    "^os$": "<rootDir>/tests/helpers/os-shim.js",
  },
  testTimeout: 30000,
  transform: {
    "^.+\\.ts$": [
      "ts-jest",
      {
        useESM: false,
      },
    ],
  },
};
