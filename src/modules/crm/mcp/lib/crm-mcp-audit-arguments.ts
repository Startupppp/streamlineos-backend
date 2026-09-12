/*
 * What of a tool call goes into its audit entry. `CrmMcpService` re-exports
 * both functions.
 */

/**
 * What of a tool call is safe and useful to keep.
 *
 * Ids, numbers and booleans are kept: they are what makes an entry
 * reconstructable — "read deal 412" rather than "read a deal". Free text is
 * not, because the only string arguments these tools take are search terms,
 * and a tenant's audit log should not accumulate a second copy of everything
 * anybody has ever searched for. Its presence is recorded instead, so a
 * reviewer can see a search happened and how long the term was.
 */
export function auditableArguments(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      continue;
    }
    if (typeof value === "string") {
      /** An id is worth keeping verbatim; a search term is not. */
      out[key] = /^[0-9]+$/.test(value) || UUID.test(value)
        ? value
        : { redacted: true, length: value.length };
      continue;
    }
    if (value === null) out[key] = null;
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How much came back, when that is answerable.
 *
 * The services behind these tools return several shapes — a bare array, a
 * paginated envelope, a single record. Null rather than 0 where it cannot be
 * told, because "one row" and "could not count" must not read the same.
 */
export function countResults(result: unknown): number | null {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    const data = (result as { data?: unknown; items?: unknown }).data ??
      (result as { items?: unknown }).items;
    if (Array.isArray(data)) return data.length;
    return 1;
  }
  return result === undefined || result === null ? 0 : 1;
}
