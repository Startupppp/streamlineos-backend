import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { EmploymentBackfillContextModule } from "./employment-backfill-context";
import { EmploymentReconciliationService } from "../modules/hr/core/employment-reconciliation.service";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { organizations } from "../db/schema";
import {
  resetEmploymentFallbacks,
  snapshotEmploymentFallbacks,
} from "../modules/directory/employment-fallback-counter";
import { EmploymentFactsService } from "../modules/directory/employment-facts.service";
import { runInNewTenantTransaction } from "../common/tenant/run-in-tenant-transaction";

async function main(): Promise<void> {
  const orgId = process.argv[2];

  const app = await NestFactory.createApplicationContext(EmploymentBackfillContextModule, {
    logger: ["error", "warn"],
  });

  try {
    const reconcile = app.get(EmploymentReconciliationService);
    const facts = app.get(EmploymentFactsService);
    const db = app.get<Db>(DRIZZLE);

    const targets =
      orgId && orgId !== "--all"
        ? [{ id: orgId }]
        : await db.select({ id: organizations.id }).from(organizations);

    let total = 0;
    let resolvedPeople = 0;
    const placed = new Set<string>();
    resetEmploymentFallbacks();
    for (const org of targets) {
      const memberIds = await reconcile.activeMemberUserIds(org.id);
      for (const userId of memberIds) placed.add(userId);

      await runInNewTenantTransaction(db, org.id, async () => {
        await facts.getFactsBatch(org.id, memberIds);
        await facts.getSensitiveFactsBatch(org.id, memberIds);
      });
      resolvedPeople += memberIds.length;

      const drift = await reconcile.reconcileOrg(org.id);
      total += drift.length;
      for (const row of drift) console.log(JSON.stringify(row));
    }

    const orphans = await reconcile.findOrphanedFacts(placed);
    for (const orphan of orphans)
      console.log(JSON.stringify({ orphanedEmploymentFacts: orphan }));

    console.log(
      JSON.stringify({
        summary: true,
        organizations: targets.length,
        disagreements: total,
        orphanedUsers: orphans.length,
        peopleResolvedThroughAccessor: resolvedPeople,
        fallbacks: snapshotEmploymentFallbacks(),
      }),
    );
    process.exitCode = total === 0 && orphans.length === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
