import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { PersonEmploymentSyncService } from "../modules/hr-core/person-employment-sync.service";
import { DRIZZLE } from "../db/drizzle.constants";
import type { Db } from "../db/drizzle.module";
import { organizations } from "../db/schema";

async function main(): Promise<void> {
  const orgId = process.argv[2];
  const actorId = process.argv[3] ?? "system-backfill";

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const sync = app.get(PersonEmploymentSyncService);
    const db = app.get<Db>(DRIZZLE);

    const targets = orgId
      ? [{ id: orgId }]
      : await db.select({ id: organizations.id }).from(organizations);

    for (const org of targets) {
      const result = await sync.backfillOrg(org.id, actorId);
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          orgId: org.id,
          ...result,
        }),
      );
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
