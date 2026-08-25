import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { KbArticleMigrationService } from "../modules/kb/article-conversion/kb-article-migration.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn", "log"],
  });

  try {
    const service = app.get(KbArticleMigrationService);
    console.log(JSON.stringify(await service.reportAll(), null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
