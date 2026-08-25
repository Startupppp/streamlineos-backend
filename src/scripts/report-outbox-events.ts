import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "../app.module";
import { OutboxPublisherService } from "../common/outbox/outbox-publisher.service";

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ["error", "warn"],
  });
  try {
    const report = await app.get(OutboxPublisherService).reportByOrganization();
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), organizations: report }, null, 2));
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
