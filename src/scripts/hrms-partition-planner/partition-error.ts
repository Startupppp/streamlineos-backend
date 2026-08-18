export class PartitionPlannerError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PartitionPlannerError";
  }
}

export function failPartition(code: string): never {
  throw new PartitionPlannerError(code);
}

export function safePartitionFailureCode(error: unknown): string {
  if (error instanceof PartitionPlannerError) return error.code;
  if (error instanceof SyntaxError) return "PARTITION_INPUT_INVALID";
  if (error instanceof Error && error.name === "ZodError")
    return "PARTITION_INPUT_INVALID";
  const candidate = error as { code?: unknown };
  if (
    typeof candidate.code === "string" &&
    /^[A-Z0-9]{5}$/.test(candidate.code.toUpperCase())
  )
    return `PARTITION_DATABASE_${candidate.code.toUpperCase()}`;
  return "PARTITION_OPERATION_FAILED";
}
