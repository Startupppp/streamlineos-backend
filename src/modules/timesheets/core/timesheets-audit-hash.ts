import { createHash } from "node:crypto";

export interface AuditEventParams {
  orgId: string;
  actorMembershipId: number | null;
  entityType: string;
  entityId: string;
  action: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** JSON.stringify with recursively sorted object keys, so hashes survive
 *  Postgres jsonb round-trips (jsonb does not preserve key order). */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  const toJson: unknown = Reflect.get(value, "toJSON");
  if (typeof toJson === "function") {
    return stableStringify(toJson.call(value));
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function computeAuditRowHash(
  prevHash: string | null,
  params: AuditEventParams,
): string {
  const canonical = stableStringify({
    prevHash: prevHash ?? "",
    orgId: params.orgId,
    actorMembershipId: String(params.actorMembershipId ?? ""),
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    before: params.before ?? null,
    after: params.after ?? null,
    reason: params.reason ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}
