import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { EmploymentBackfillContextModule } from "./employment-backfill-context";
import { EmploymentBackfillService } from "../modules/hr/core/employment-backfill.service";
import { EmploymentReconciliationService } from "../modules/hr/core/employment-reconciliation.service";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { organizations } from "../db/schema";

async function main(): Promise<void> {
  const orgId = process.argv[2];
  const actorId = process.argv[3] ?? null;

  const app = await NestFactory.createApplicationContext(EmploymentBackfillContextModule, {
    logger: ["error", "warn"],
  });

  try {
    const backfill = app.get(EmploymentBackfillService);
    const reconcile = app.get(EmploymentReconciliationService);
    const db = app.get<Db>(DRIZZLE);

    const targets =
      orgId && orgId !== "--all"
        ? [{ id: orgId }]
        : await db.select({ id: organizations.id }).from(organizations);

    let totalUnmappable = 0;
    let totalDrift = 0;

    for (const org of targets) {
      const result = await backfill.backfillOrg(org.id, actorId);
      const drift = await reconcile.reconcileOrg(org.id);
      totalUnmappable += result.unmappable.length;
      totalDrift += drift.length;
      if (
        result.scanned > 0 ||
        result.unmappable.length > 0 ||
        drift.length > 0 ||
        result.errors.length > 0
      )
        console.log(JSON.stringify({ orgId: org.id, ...result, drift }));
    }

    console.log(
      JSON.stringify({
        summary: true,
        organizations: targets.length,
        unmappable: totalUnmappable,
        drift: totalDrift,
      }),
    );
    process.exitCode = totalUnmappable === 0 && totalDrift === 0 ? 0 : 1;
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
