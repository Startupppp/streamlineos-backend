/**
 * Phase 11.2 — HR/policy AI guardrails.
 * Explain/draft/advisory only. Never invent policy or execute payroll money actions.
 */

export const HR_POLICY_AI_CAPABILITY = {
  mode: "explain_draft_only" as const,
  mayInventPolicy: false,
  mayApprovePayroll: false,
  mayFileStatutory: false,
  mayMoveMoney: false,
  honestyLabel:
    "AI answers from active HR policy records only — not official legal advice or payroll authority",
  note: "Citations must reference policies present in the evidence set. Human review required for escalations and employment decisions.",
} as const;

export const FORBIDDEN_HR_AI_ACTIONS = [
  "approve_run",
  "lock_run",
  "mark_paid",
  "generate_payout_batch",
  "submit_statutory_filing",
  "recalculate_payroll",
  "change_salary",
  "override_exception",
  "invent_policy_rule",
] as const;

export interface PolicyEvidenceCitation {
  policyId: number;
  policyType: string;
  policyName: string | null;
  snippet: string;
  path: string;
  source: "hr_policy_registry";
}

/**
 * Drop model-hallucinated citations that do not match policies loaded as evidence.
 */
export function sanitizePolicyCitations(
  raw: Array<{ policyType: string; policyId: number; snippet: string }>,
  evidence: Array<{ id: number; policyType: string; name: string | null }>,
): PolicyEvidenceCitation[] {
  const byId = new Map(evidence.map((p) => [p.id, p]));
  const out: PolicyEvidenceCitation[] = [];
  const seen = new Set<number>();

  for (const c of raw) {
    if (!Number.isFinite(c.policyId) || seen.has(c.policyId)) continue;
    const pol = byId.get(c.policyId);
    if (!pol) continue;
    seen.add(c.policyId);
    out.push({
      policyId: pol.id,
      policyType: pol.policyType,
      policyName: pol.name,
      snippet: (c.snippet ?? "").slice(0, 400),
      path: `hr_policies[${pol.id}]`,
      source: "hr_policy_registry",
    });
  }
  return out;
}

export function isForbiddenPayrollAiAction(action: string): boolean {
  return (FORBIDDEN_HR_AI_ACTIONS as readonly string[]).includes(action);
}
