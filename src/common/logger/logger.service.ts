type LogLevel = "debug" | "info" | "warn" | "error";
const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const current: LogLevel = process.env.NODE_ENV === "production" ? "info" : "debug";

function emit(level: LogLevel, message: string, meta?: unknown): void {
  if (LEVELS[level] < LEVELS[current]) return;
  const base = { timestamp: new Date().toISOString(), level, message };
  const line = JSON.stringify(meta !== undefined ? { ...base, meta } : base);
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export const logger = {
  debug: (m: string, meta?: unknown) => emit("debug", m, meta),
  info: (m: string, meta?: unknown) => emit("info", m, meta),
  warn: (m: string, meta?: unknown) => emit("warn", m, meta),
  error: (m: string, meta?: unknown) => emit("error", m, meta),
};
