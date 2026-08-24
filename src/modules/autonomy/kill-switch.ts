import type { DecisionKind } from "../../db/schema/crm/autonomous-decisions";

/**
 * Resolving whether the system is allowed to act.
 *
 * Pure, and deliberately paranoid in one direction only: every ambiguity
 * resolves to *not acting*. A switch that fails open is not a safety mechanism,
 * it is a safety mechanism-shaped object.
 */

export interface SwitchRow {
  /** null is the platform-wide switch. */
  readonly organizationId: string | null;
  /** A decision kind, or `*`. */
  readonly kind: string;
  readonly enabled: boolean;
  readonly reason?: string | null;
}

export interface SwitchDecision {
  readonly allowed: boolean;
  /** Which row decided it, for the operator who asks why nothing is happening. */
  readonly decidedBy: "platform-all" | "platform-kind" | "org-all" | "org-kind" | "default";
  readonly reason: string | null;
}

/**
 * Whether this organisation may take this action right now.
 *
 * Precedence runs from the widest veto inward: a platform switch beats an
 * organisation's, and `*` beats a specific kind. That ordering matters — an
 * operator killing everything platform-wide must not be overridden by a tenant
 * who had explicitly enabled one action type.
 */
export function resolveSwitch(
  organizationId: string,
  kind: DecisionKind,
  rows: readonly SwitchRow[],
): SwitchDecision {
  const find = (org: string | null, key: string): SwitchRow | undefined =>
    rows.find((row) => row.organizationId === org && row.kind === key);

  const platformAll = find(null, "*");
  if (platformAll && !platformAll.enabled)
    return { allowed: false, decidedBy: "platform-all", reason: platformAll.reason ?? null };

  const platformKind = find(null, kind);
  if (platformKind && !platformKind.enabled)
    return { allowed: false, decidedBy: "platform-kind", reason: platformKind.reason ?? null };

  const orgAll = find(organizationId, "*");
  if (orgAll && !orgAll.enabled)
    return { allowed: false, decidedBy: "org-all", reason: orgAll.reason ?? null };

  const orgKind = find(organizationId, kind);
  if (orgKind && !orgKind.enabled)
    return { allowed: false, decidedBy: "org-kind", reason: orgKind.reason ?? null };

  // Nothing turned it off. Autonomy is on by default, which is the product's
  // whole premise — the switches exist to stop it, not to opt into it.
  return { allowed: true, decidedBy: "default", reason: null };
}

/**
 * Never reads another organisation's switches.
 *
 * A switch row is scoped, and resolving with a set that contains a foreign
 * organisation's rows would let one tenant's kill switch stop another's product.
 */
export function switchesFor(
  organizationId: string,
  rows: readonly SwitchRow[],
): SwitchRow[] {
  return rows.filter(
    (row) => row.organizationId === null || row.organizationId === organizationId,
  );
}
