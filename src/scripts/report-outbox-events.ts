import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ArchitectureEvidenceModule } from "./architecture-evidence.module";
import { OutboxPublisherService } from "../common/outbox/outbox-publisher.service";
import { ExternalEffectLedger } from "../common/outbox/external-effect-ledger";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(ArchitectureEvidenceModule, {
    logger: false,
  });
  try {
    const outbox = await app.get(OutboxPublisherService).report();
    const externalEffects = await app.get(ExternalEffectLedger).report();
    console.log(JSON.stringify({ outbox, externalEffects }, null, 2));
    if (
      outbox.failed > 0 ||
      outbox.succeeded !== outbox.organizations ||
      (externalEffects.deployed && (
        externalEffects.failed > 0 || externalEffects.succeeded !== externalEffects.organizations
      ))
    ) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
