export function resolveAssigneeId(raw: string | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === "" || raw === "unassigned") return null;
  return raw;
}
