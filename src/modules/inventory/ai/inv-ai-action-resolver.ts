import {
  INV_AI_ACTIONS,
  evidenceRefKey,
  type InvAiAction,
  type InvAiRecommendation,
  type InvEvidenceKind,
  type InvEvidenceReference,
} from "./dto/inv-ai-contract";

/**
 * INV-102 — the server side of every action a model proposes.
 *
 * The model contributes exactly one token: which member of `INV_AI_ACTIONS`
 * this is. Everything that gives an action teeth — the route it opens, the
 * permission it demands, whether it mutates, which record it targets — is
 * looked up here, from a table in this file, against evidence the server
 * retrieved. A model cannot name a route, cannot name a permission, cannot
 * widen its own authority by writing a different string, and cannot cause a
 * mutation: the two mutating actions resolve to `href: null` and are rendered
 * as a request for confirmation, never as a link.
 */

export interface ResolvedInvAiAction {
  action: InvAiAction;
  label: string;
  /**
   * Where a human goes to look. `null` for actions that change something —
   * those go through the existing confirmation flow, and a link that quietly
   * performed a mutation is exactly what this contract exists to prevent.
   */
  href: string | null;
  /** Checked against the *viewer*, not the proposer. */
  permission: string;
  mutates: boolean;
  rationale: string;
  evidence: InvEvidenceReference[];
}

interface ActionDefinition {
  label: string;
  permission: string;
  mutates: boolean;
  /** Which evidence kind supplies the record id, when the route wants one. */
  target: InvEvidenceKind | null;
  href: (targetId: number | null) => string | null;
}

const ACTION_TABLE: Readonly<Record<InvAiAction, ActionDefinition>> = {
  review_reorder_suggestion: {
    label: "Review the reorder suggestion",
    permission: "inventory:replenishment:manage",
    mutates: false,
    target: "reorder_suggestion",
    href: () => "/inventory/replenishment",
  },
  draft_purchase_order: {
    label: "Draft a purchase order",
    permission: "inventory:purchase-orders:create",
    mutates: true,
    target: "vendor",
    href: () => null,
  },
  open_stock_movements: {
    label: "Open the movement history",
    permission: "inventory:stock:read",
    mutates: false,
    target: "product_variant",
    href: (id) =>
      id === null
        ? "/inventory/stock/movements"
        : `/inventory/stock/movements?variantId=${id}`,
  },
  open_expiry_report: {
    label: "Open the expiry report",
    permission: "inventory:reports:read",
    mutates: false,
    target: null,
    href: () => "/inventory/reports/expiry",
  },
  review_vendor_performance: {
    label: "Review vendor performance",
    permission: "inventory:vendors:read",
    mutates: false,
    target: "vendor",
    href: (id) => (id === null ? "/inventory/vendors" : `/inventory/vendors/${id}`),
  },
  acknowledge_insight: {
    label: "Acknowledge this insight",
    permission: "inventory:ai:manage",
    mutates: true,
    target: "insight",
    href: () => null,
  },
  dismiss_insight: {
    label: "Dismiss this insight",
    permission: "inventory:ai:manage",
    mutates: true,
    target: "insight",
    href: () => null,
  },
};

/**
 * Every action has a table entry. Zod already rejects an action outside the
 * enum, so this guards the other direction: a member added to `INV_AI_ACTIONS`
 * without deciding its permission and blast radius fails here, at boot, rather
 * than resolving to `undefined` and rendering as an unguarded link.
 */
const missingDefinitions = INV_AI_ACTIONS.filter((action) => !ACTION_TABLE[action]);
if (missingDefinitions.length > 0) {
  throw new Error(
    `inv-ai-action-resolver: no definition for ${missingDefinitions.join(", ")}`,
  );
}

export class InvAiEvidenceError extends Error {
  constructor(public readonly references: string[]) {
    super(
      `AI response cited evidence the server never retrieved: ${references.join(", ")}`,
    );
    this.name = "InvAiEvidenceError";
  }
}

/**
 * The set of references a response is permitted to cite, built from the rows
 * the deterministic layer actually read.
 */
export function buildEvidenceAllowlist(
  references: readonly InvEvidenceReference[],
): ReadonlySet<string> {
  return new Set(references.map(evidenceRefKey));
}

/**
 * A citation the server cannot vouch for is the failure mode that matters
 * most here: an invented id renders identically to a real one, and reads as
 * corroboration. So an unknown reference rejects the response rather than
 * being quietly dropped -- dropping it would leave a confident narrative whose
 * support had silently been removed.
 */
export function assertEvidenceKnown(
  references: readonly InvEvidenceReference[],
  allowlist: ReadonlySet<string>,
): void {
  const unknown = references
    .map(evidenceRefKey)
    .filter((key) => !allowlist.has(key));
  if (unknown.length > 0) throw new InvAiEvidenceError([...new Set(unknown)]);
}

export function resolveInvAiActions(
  recommendations: readonly InvAiRecommendation[],
  allowlist: ReadonlySet<string>,
): ResolvedInvAiAction[] {
  for (const recommendation of recommendations) {
    assertEvidenceKnown(recommendation.evidence, allowlist);
  }

  return recommendations.map((recommendation) => {
    const definition = ACTION_TABLE[recommendation.action];
    const targetId =
      definition.target === null
        ? null
        : (recommendation.evidence.find((ref) => ref.kind === definition.target)?.id ??
          null);

    return {
      action: recommendation.action,
      label: definition.label,
      href: definition.href(targetId),
      permission: definition.permission,
      mutates: definition.mutates,
      rationale: recommendation.rationale,
      evidence: recommendation.evidence,
    };
  });
}
