/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  testMatch: [
    "<rootDir>/src/**/*.test.ts",
    "<rootDir>/tests/**/*.test.ts",
  ],
  moduleFileExtensions: ["ts", "js", "json"],
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
