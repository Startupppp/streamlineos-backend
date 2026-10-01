import type { DeclaredCell } from "../matrix.types";

const BOLA = "test/security/bola";
const SECURITY = "test/security";

const SUITES: ReadonlyArray<readonly [string, string]> = [
  ["generic:body-id", `${BOLA}/bola-body-id-binding.spec.ts`],
  ["generic:body-synthesis", `${BOLA}/bola-body-synthesis.spec.ts`],
  ["generic:bulk-ids", `${BOLA}/bola-bulk-fail-whole.spec.ts`],
  ["generic:bulk-mixed-tenant", `${BOLA}/bola-bulk-mixed-tenant.spec.ts`],
  ["generic:data-layer", `${BOLA}/bola-data-layer-binding.spec.ts`],
  ["sign:envelope-children", `${BOLA}/bola-esign-envelope-children-404.spec.ts`],
  ["sign:scope-sweeps", `${BOLA}/bola-esign-scope-sweeps-and-token.spec.ts`],
  ["hr:headcount-plan", `${BOLA}/bola-headcount-plan-404.spec.ts`],
  ["hr:workflow-instance", `${BOLA}/bola-hr-workflow-instances-404.spec.ts`],
  ["hr:write-parent", `${BOLA}/bola-hr-write-parent-404.spec.ts`],
  ["kb:reindex", `${BOLA}/bola-kb-reindex-404.spec.ts`],
  ["generic:live-cross-tenant", `${BOLA}/bola-live-cross-tenant.seeded-e2e-spec.ts`],
  ["generic:live-probe-plan", `${BOLA}/bola-live-probe-plan.spec.ts`],
  ["org:purge-path", `${BOLA}/bola-org-purge-path-404.spec.ts`],
  ["payroll:payee-eligibility", `${BOLA}/bola-payee-eligibility-404.spec.ts`],
  ["payroll:worker-history", `${BOLA}/bola-payroll-worker-history-404.spec.ts`],
  ["org:public-selector", `${BOLA}/bola-public-org-selector.spec.ts`],
  ["kb:rag-object-scope", `${BOLA}/bola-rag-object-scope.spec.ts`],
  ["generic:route-surface", `${BOLA}/bola-route-surface.spec.ts`],
  ["generic:scope-gate-integrity", `${BOLA}/bola-scope-gate-integrity.spec.ts`],
  ["generic:scope-sibling-drift", `${BOLA}/bola-scope-sibling-drift.spec.ts`],
  ["generic:strict-params-drift", `${BOLA}/bola-strict-params-drift.spec.ts`],
  ["support:inbound-secret", `${BOLA}/bola-support-inbound-secret.spec.ts`],
  ["surveys:collector", `${BOLA}/bola-survey-collector-404.spec.ts`],
  ["generic:versioned-operation-id", `${BOLA}/bola-versioned-operation-id.spec.ts`],
  ["hr:directory-assets", `${BOLA}/hr-directory-assets-cross-tenant.spec.ts`],
  ["generic:own-tenant-500", `${BOLA}/t15-own-tenant-500.seeded-e2e-spec.ts`],
  ["generic:bulk-search-public-token", `${SECURITY}/bola-bulk-search-public-token.spec.ts`],
  ["generic:export-download", `${SECURITY}/bola-export-download.spec.ts`],
  ["realtime:channel-scope", `${SECURITY}/bola-realtime-channel-scope.spec.ts`],
];

export function declaredCells(): DeclaredCell[] {
  return SUITES.map(([resource, evidenceSuite]) => ({
    kind: "declared",
    id: `declared:${evidenceSuite.slice(evidenceSuite.lastIndexOf("/") + 1).replace(/\.(seeded-e2e-)?spec\.ts$/, "")}`,
    resource,
    evidenceSuite,
  }));
}
