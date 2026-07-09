export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  setupFiles: ['dotenv/config'],
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^@app/(.*)$': '<rootDir>/packages/$1/src',
  },
  // @ai-sdk/* and `ai` are pure ESM — let ts-jest transform them
  transformIgnorePatterns: ['/node_modules/(?!(@ai-sdk|ai)/)'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        useESM: true,
        tsconfig: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'Node',
          esModuleInterop: true,
        },
      },
    ],
    '^.+\\.jsx?$': [
      'ts-jest',
      {
        useESM: true,
      },
    ],
  },
};
