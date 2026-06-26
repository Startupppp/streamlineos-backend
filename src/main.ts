import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.validation";
import { AllExceptionsFilter } from "./common/http/all-exceptions.filter";

async function bootstrap(): Promise<void> {
  const config = validateEnv();
  const app = await NestFactory.create(AppModule, { bufferLogs: false, rawBody: true });
  app.use(helmet());
  app.enableCors({ origin: config.corsOrigins, credentials: false });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();
  await app.listen(config.PORT);
}

void bootstrap();
