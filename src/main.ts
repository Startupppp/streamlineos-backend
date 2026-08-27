import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { LogLevel } from "@nestjs/common";
import { setDefaultResultOrder } from "node:dns";
import type { NestExpressApplication } from "@nestjs/platform-express";

import helmet from "helmet";
import compression from "compression";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { recordRouteClassification } from "./common/auth/record-route-classification";

import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.validation";
import { AllExceptionsFilter } from "./common/http/all-exceptions.filter";
import { correlationIdMiddleware } from "./common/http/correlation-id.middleware";
import {
  LogErrorReporter,
  LogSpanExporter,
  reportError,
  setErrorReporter,
  setSpanExporter,
  structuredNestLogger,
} from "./common/observability";
import { ResponseTransformInterceptor } from "./common/interceptors/response-transform.interceptor";
import { logger } from "./common/logger/logger.service";

setDefaultResultOrder("ipv4first");

function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection — process kept alive", {
    error: describeError(reason),
  });
  // Also through the reporter, so a rejection is fingerprinted and classified
  // like any other failure. A dropped `void something(...)` is exactly how the
  // tenant-context outage stayed invisible, and that is the classification
  // (`errorClass: "tenant-context"`) that would have named it.
  reportError(reason, { source: "unhandledRejection" });
});

async function bootstrap(): Promise<void> {
  const config = validateEnv();

  const isDevelopment = config.NODE_ENV === "development";

  const productionLogLevels: LogLevel[] = ["fatal"];
  const developmentLogLevels: LogLevel[] = ["log", "debug", "verbose"];

  const logLevels: LogLevel[] = [
    "warn",
    "error",
    ...(isDevelopment ? developmentLogLevels : productionLogLevels),
  ];

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
    bufferLogs: false,
    logger: logLevels,
  });

  // Routes the framework's own output, and the ~70 modules that construct a Nest
  // `Logger`, through the structured logger so every line is JSON and carries the
  // request's correlation id.
  app.useLogger(structuredNestLogger);

  // Both ports default to a noop, so an unwired deployment reports nothing and
  // says nothing about it. These two calls are what make c20 real: errors reach
  // a queryable log record, and every finished span carries the latency p95 is
  // computed from.
  setErrorReporter(new LogErrorReporter());
  setSpanExporter(new LogSpanExporter());

  app.use(helmet());
  app.use(compression());
  app.enableShutdownHooks();
  app.use(correlationIdMiddleware);

  app.enableCors({
    origin: isDevelopment
      ? (origin, callback) => {
          callback(null, !origin || config.corsOrigins.includes(origin));
        }
      : config.corsOrigins,
    credentials: true,
  });

  app.useBodyParser("json", { limit: "3mb" });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.useBodyParser("urlencoded", { extended: true, limit: "1mb" });

  if (isDevelopment) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("StreamlineOS API")
      .setDescription("StreamlineOS platform REST API")
      .setVersion("1.0")
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    const classification = recordRouteClassification(app, document);
    logger.info(
      `OpenAPI: exposure recorded on ${classification.stamped} operation(s), ${classification.undeclared} undeclared`,
    );
    SwaggerModule.setup("api/docs", app, document);
  }

  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  logger.error("Fatal: application bootstrap failed", { error: describeError(error) });
  process.exit(1);
});
