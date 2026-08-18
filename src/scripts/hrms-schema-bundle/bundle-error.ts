import { z } from "zod";

const databaseErrorSchema = z.object({ code: z.string() }).passthrough();

export class BundleRunnerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BundleRunnerError";
  }
}

export function fail(code: string): never {
  throw new BundleRunnerError(code);
}

export function safeFailureCode(error: unknown): string {
  if (error instanceof BundleRunnerError) return error.code;
  const parsed = databaseErrorSchema.safeParse(error);
  if (parsed.success && /^[A-Z0-9]{5}$/.test(parsed.data.code.toUpperCase()))
    return `DATABASE_${parsed.data.code.toUpperCase()}`;
  if (error instanceof SyntaxError) return "RUNNER_INPUT_INVALID";
  if (error instanceof Error && error.name === "ZodError")
    return "RUNNER_INPUT_INVALID";
  return "RUNNER_OPERATION_FAILED";
}
