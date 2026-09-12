/**
 * Every operation permitted to name a region rather than a tenant.
 *
 * Phase 3, ticket 10.
 *
 * Almost all regional resolution is by ORG: `dbForOrg`, `storageForOrg`,
 * `regionForOrg` all take a tenant and hand back that tenant's own region. Those
 * are not cross-region and are not listed here — a caller cannot reach anywhere
 * it should not, because the org decides.
 *
 * The dangerous shape is naming a REGION directly. `bindingFor("eu")` hands back
 * the EU connection whoever asks; `withNewOrgInRegion(db, { region })` opens a
 * transaction wherever the caller says. Both are necessary — an organisation has
 * to be created somewhere before it has a region to resolve, and the public
 * storage URL belongs to the deployment rather than to any one tenant — but
 * neither should be reachable from an ordinary service.
 *
 * So the permitted set is enumerated, each entry carries the argument for why
 * it is permitted, and `cross-region.spec.ts` fails the build when a file not
 * listed here reaches for one. The list is meant to stay short. If an entry
 * needs a paragraph to justify, that is usually a sign the operation should be
 * resolving by org instead.
 */
export interface CrossRegionOperation {
  /** Path from the repo root, exactly as the guard sees it. */
  readonly file: string;
  /** Why naming a region is correct here, and resolving by org is not. */
  readonly why: string;
}

export const CROSS_REGION_OPERATIONS: readonly CrossRegionOperation[] = [
  {
    file: "src/common/region/cell-admission.ts",
    why:
      "Decides which cell may accept a tenant, which means reading every " +
      "cell's declared tenant classes and compliance zones. Admission is the " +
      "one question that cannot be answered from inside a single region, " +
      "because the answer is which region.",
  },
  {
    file: "src/common/tenant/for-each-org.ts",
    why:
      "Walks every organisation in the deployment, which is every region by " +
      "definition. Cron ticks and backfills use it, and the alternative — one " +
      "pass per region at each call site — is how a region gets forgotten.",
  },
  {
    file: "src/scripts/verify-cell-degraded-control-plane.ts",
    why:
      "An operator script that proves a cell still serves reads when the " +
      "control plane is unreachable, so it has to bind the cell's own " +
      "connection rather than resolve one through the plane it is testing.",
  },
  {
    file: "src/common/region/region-registry.ts",
    why: "Defines the primitives. It is what everything else is measured against.",
  },
  {
    file: "src/common/tenant/with-tenant.ts",
    why:
      "Defines `withNewOrgInRegion`, the one way to open a transaction in a " +
      "stated region. It exists because an organisation's own row is written " +
      "inside the transaction that creates it, so there is nothing to resolve " +
      "a region from yet.",
  },
  {
    file: "src/common/tenant/run-in-tenant-transaction.ts",
    why: "Wraps `withNewOrgInRegion` in the tenant context every caller needs.",
  },
  {
    file: "src/common/tenant/index.ts",
    why: "Barrel. Re-exports the primitive; performs no operation itself.",
  },
  {
    file: "src/modules/organization/core/cell-organization-state.ts",
    why:
      "The signup path's own region naming, which is where the organisation " +
      "row is read back from the region admission just placed it in — there " +
      "is nothing to resolve a region from, because the org row is the thing " +
      "being created. The compensation path needs it most: `register` has to " +
      "ask whether the row landed before it unplaces the organisation, and " +
      "asking the wrong region answers 'no' and strands a real tenant.",
  },
  {
    file: "src/modules/organization/core/org-profile.service.ts",
    why: "The second organisation-creation path. Same argument as signup.",
  },
  {
    file: "src/common/region/region.module.ts",
    why:
      "Reports the configured topology at boot and refuses to start on a " +
      "misconfiguration. Reads region names; opens no connection to one.",
  },
  {
    file: "src/modules/compliance/subject-requests/subject-requests.service.ts",
    why:
      "A data subject's right runs across the whole deployment, not across one " +
      "tenant — there is no org to resolve from, because the subject may appear " +
      "in many and the request must reach the regions holding organisations " +
      "nobody thought to name. `registry.keys` is also the list " +
      "`mayReportComplete` is checked against, so a region added and left out " +
      "of the enumeration makes the request refuse to report itself complete " +
      "instead of quietly leaving that region's copy behind.",
  },
  {
    file: "src/modules/storage/storage-placement.ts",
    why:
      "`getConfig` reads the PRIMARY region's own storage binding — the " +
      "fallback for a deployment that has a registry but is asked for " +
      "placement with no organisation in hand (`isConfigured`, boot checks). " +
      "Every tenant-owned object still resolves through `storageForOrg`.",
  },
];

export const CROSS_REGION_FILES: ReadonlySet<string> = new Set(
  CROSS_REGION_OPERATIONS.map((operation) => operation.file),
);
