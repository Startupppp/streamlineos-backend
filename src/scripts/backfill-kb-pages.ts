import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { KbPageBackfillService } from "../modules/kb/retrieval/kb-page-backfill.service";

async function main(): Promise<void> {
  const delayMs = Number.parseInt(process.argv[2] ?? "100", 10);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const backfill = app.get(KbPageBackfillService);
    const result = await backfill.backfillAll({
      delayMs: Number.isNaN(delayMs) ? 100 : delayMs,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
