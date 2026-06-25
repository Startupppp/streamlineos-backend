import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.validation";

async function bootstrap(): Promise<void> {
  const config = validateEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
