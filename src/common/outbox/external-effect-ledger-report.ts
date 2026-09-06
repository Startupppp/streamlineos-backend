import { sql } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { externalEffectLedger } from "../../db/schema/common/outbox";
import { forEachOrg } from "../tenant/for-each-org";

export interface ExternalEffectLedgerReport {
  deployed: boolean;
  organizations: number;
  succeeded: number;
  failed: number;
  totalRows: number;
  pending: number;
  inFlight: number;
  succeededEffects: number;
  failedEffects: number;
  uncertainRetries: number;
  providerEnforcedEffects: number;
  stableKeyOnlyEffects: number;
  noProviderIdempotencyEffects: number;
}

export async function reportExternalEffectLedger(db: Db): Promise<ExternalEffectLedgerReport> {
  const presence = await db.execute(sql`
    select to_regclass('public.external_effect_ledger') is not null as deployed
  `);
  const deployed = presence[0]?.["deployed"] === true;
  const report: ExternalEffectLedgerReport = {
    deployed,
    organizations: 0,
    succeeded: 0,
    failed: 0,
    totalRows: 0,
    pending: 0,
    inFlight: 0,
    succeededEffects: 0,
    failedEffects: 0,
    uncertainRetries: 0,
    providerEnforcedEffects: 0,
    stableKeyOnlyEffects: 0,
    noProviderIdempotencyEffects: 0,
  };
  if (!deployed) return report;

  const sweep = await forEachOrg(db, "external-effect-ledger-report", async (tx) => {
    const rows = await tx.select({
      totalRows: sql<number>`count(*)`,
      pending: sql<number>`count(*) filter (where ${externalEffectLedger.state} = 'PENDING')`,
      inFlight: sql<number>`count(*) filter (where ${externalEffectLedger.state} = 'IN_FLIGHT')`,
      succeededEffects: sql<number>`count(*) filter (where ${externalEffectLedger.state} = 'SUCCEEDED')`,
      failedEffects: sql<number>`count(*) filter (where ${externalEffectLedger.state} = 'FAILED')`,
      uncertainRetries: sql<number>`coalesce(sum(${externalEffectLedger.uncertainRetryCount}), 0)`,
      providerEnforcedEffects: sql<number>`count(*) filter (where ${externalEffectLedger.providerIdempotency} = 'PROVIDER_ENFORCED')`,
      stableKeyOnlyEffects: sql<number>`count(*) filter (where ${externalEffectLedger.providerIdempotency} = 'STABLE_KEY_PROPAGATED')`,
      noProviderIdempotencyEffects: sql<number>`count(*) filter (where ${externalEffectLedger.providerIdempotency} = 'NONE')`,
    }).from(externalEffectLedger);
    const row = rows[0];
    report.totalRows += Number(row?.totalRows ?? 0);
    report.pending += Number(row?.pending ?? 0);
    report.inFlight += Number(row?.inFlight ?? 0);
    report.succeededEffects += Number(row?.succeededEffects ?? 0);
    report.failedEffects += Number(row?.failedEffects ?? 0);
    report.uncertainRetries += Number(row?.uncertainRetries ?? 0);
    report.providerEnforcedEffects += Number(row?.providerEnforcedEffects ?? 0);
    report.stableKeyOnlyEffects += Number(row?.stableKeyOnlyEffects ?? 0);
    report.noProviderIdempotencyEffects += Number(row?.noProviderIdempotencyEffects ?? 0);
  });
  report.organizations = sweep.organizations;
  report.succeeded = sweep.succeeded;
  report.failed = sweep.failed;
  return report;
}
