/** What a completed putaway reports, and how it survives a round trip through jsonb. */
export interface PutawayCompletionResult {
  taskId: number;
  status: "IN_PROGRESS" | "COMPLETED";
  lines: Array<{ taskLineId: number; quantityMoved: string; toLocationId: number }>;
  transactionIds: number[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Rebuilds a stored completion rather than casting one.
 *
 * The stored response is JSON that has been through the database, so numbers may
 * come back as strings and a blind `as PutawayCompletionResult` is a lie the
 * type system cannot catch — the same reason `runIdempotent` takes a `revive`
 * function instead of a type argument.
 */
export function revivePutawayCompletion(stored: unknown): PutawayCompletionResult {
  const source = isRecord(stored) ? stored : {};
  const lines: PutawayCompletionResult["lines"] = [];
  if (Array.isArray(source.lines)) {
    for (const line of source.lines) {
      if (!isRecord(line)) continue;
      lines.push({
        taskLineId: Number(line.taskLineId),
        quantityMoved: String(line.quantityMoved ?? "0"),
        toLocationId: Number(line.toLocationId),
      });
    }
  }
  const transactionIds: number[] = [];
  if (Array.isArray(source.transactionIds)) {
    for (const id of source.transactionIds) {
      const parsed = Number(id);
      if (Number.isInteger(parsed)) transactionIds.push(parsed);
    }
  }
  return {
    taskId: Number(source.taskId),
    status: source.status === "COMPLETED" ? "COMPLETED" : "IN_PROGRESS",
    lines,
    transactionIds,
  };
}
