import type { EvidenceSuite } from "./matrix.types";

const BOLA = "test/security/bola";
const SECURITY = "test/security";
const NEEDS_DB = "seeded e2e: needs a real seeded database, never run by the matrix gate";

const SUITES: ReadonlyArray<readonly [string, string, string | null]> = [
  ["generic:body-id", `${BOLA}/bola-body-id-binding.spec.ts`, null],
  ["generic:body-synthesis", `${BOLA}/bola-body-synthesis.spec.ts`, null],
  ["generic:bulk-ids", `${BOLA}/bola-bulk-fail-whole.spec.ts`, null],
  ["generic:bulk-mixed-tenant", `${BOLA}/bola-bulk-mixed-tenant.spec.ts`, null],
  ["generic:data-layer", `${BOLA}/bola-data-layer-binding.spec.ts`, null],
  ["sign:envelope-children", `${BOLA}/bola-esign-envelope-children-404.spec.ts`, null],
  ["sign:scope-sweeps", `${BOLA}/bola-esign-scope-sweeps-and-token.spec.ts`, null],
  ["generic:live-cross-tenant", `${BOLA}/bola-live-cross-tenant.seeded-e2e-spec.ts`, NEEDS_DB],
  ["generic:live-probe-plan", `${BOLA}/bola-live-probe-plan.spec.ts`, null],
  ["org:purge-path", `${BOLA}/bola-org-purge-path-404.spec.ts`, null],
  ["org:public-selector", `${BOLA}/bola-public-org-selector.spec.ts`, null],
  ["kb:rag-object-scope", `${BOLA}/bola-rag-object-scope.spec.ts`, null],
  ["generic:route-surface", `${BOLA}/bola-route-surface.spec.ts`, null],
  ["generic:scope-gate-integrity", `${BOLA}/bola-scope-gate-integrity.spec.ts`, null],
  ["generic:scope-sibling-drift", `${BOLA}/bola-scope-sibling-drift.spec.ts`, null],
  ["generic:strict-params-drift", `${BOLA}/bola-strict-params-drift.spec.ts`, null],
  ["support:inbound-secret", `${BOLA}/bola-support-inbound-secret.spec.ts`, null],
  ["generic:versioned-operation-id", `${BOLA}/bola-versioned-operation-id.spec.ts`, null],
  ["generic:own-tenant-500", `${BOLA}/t15-own-tenant-500.seeded-e2e-spec.ts`, NEEDS_DB],
  ["generic:bulk-search-public-token", `${SECURITY}/bola-bulk-search-public-token.spec.ts`, null],
  ["realtime:channel-scope", `${SECURITY}/bola-realtime-channel-scope.spec.ts`, null],
];

export function evidenceSuites(): EvidenceSuite[] {
  return SUITES.map(([resource, suite, unrunnable]) => ({
    id: `suite:${suite.slice(suite.lastIndexOf("/") + 1).replace(/\.(seeded-e2e-)?spec\.ts$/, "")}`,
    resource,
    suite,
    runnable: unrunnable === null,
    reason: unrunnable ?? "run by check:rbac-matrix-ledger",
  }));
}
