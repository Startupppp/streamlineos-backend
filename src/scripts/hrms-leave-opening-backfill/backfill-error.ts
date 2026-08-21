export class LeaveOpeningBackfillError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LeaveOpeningBackfillError";
  }
}

export function fail(code: string): never {
  throw new LeaveOpeningBackfillError(code);
}

export function safeFailureCode(error: unknown): string {
  if (error instanceof LeaveOpeningBackfillError) return error.code;
  if (error instanceof SyntaxError) return "LEAVE_OPENING_INPUT_INVALID";
  if (error instanceof Error && error.name === "ZodError")
    return "LEAVE_OPENING_INPUT_INVALID";
  return "LEAVE_OPENING_OPERATION_FAILED";
}
