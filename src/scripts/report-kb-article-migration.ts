import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { KbArticleMigrationService } from "../modules/kb/article-conversion/kb-article-migration.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ArchitectureEvidenceModule, {
    logger: false,
  });

  try {
    const service = app.get(KbArticleMigrationService);
    const report = await service.reportAll();
    console.log(JSON.stringify(report, null, 2));
    if (report.failedOrganizations > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
