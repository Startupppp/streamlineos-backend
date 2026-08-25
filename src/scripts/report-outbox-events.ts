import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { OutboxPublisherService } from "../common/outbox/outbox-publisher.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ArchitectureEvidenceModule, {
    logger: false,
  });
  try {
    const report = await app.get(OutboxPublisherService).report();
    console.log(JSON.stringify(report, null, 2));
    if (report.failed > 0 || report.succeeded !== report.organizations) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
