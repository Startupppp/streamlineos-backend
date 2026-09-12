/**
 * Re-exported from the kernel so there is exactly one implementation of the
 * Drizzle error-cause unwrapping. See `kernel/pg-errors.ts` for why it exists.
 */
export { isUniqueViolation } from "../kernel/pg-errors";
