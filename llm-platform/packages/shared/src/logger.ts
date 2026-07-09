import pino from "pino";

const isDev = (process.env.NODE_ENV ?? "development") === "development";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // pretty output in dev; structured JSON everywhere else
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true } } }
    : {}),
});

export type Logger = typeof logger;
