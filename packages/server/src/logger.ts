import { pino } from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Quotes and signed payloads can reach error objects, so signatures never get logged.
  redact: ["signature", "userSignature", "authorization", "*.authorization", "*.signature", "*.userSignature"],
});
