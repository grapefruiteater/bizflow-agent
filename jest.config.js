/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/infra/test"],
  collectCoverageFrom: ["infra/lib/**/*.ts"],
  coverageDirectory: "coverage"
};
