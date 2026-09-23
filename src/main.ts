import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { type LogLevel } from "@nestjs/common";
import { setDefaultResultOrder } from "node:dns";
import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Request, Response, NextFunction } from "express";

import helmet from "helmet";
import compression from "compression";
import { httpCompressionOptions } from "./common/http/compression.config";
import { trustProxySetting } from "./common/http/trust-proxy";
import { SwaggerModule } from "@nestjs/swagger";
import { buildOpenApiDocument } from "./common/openapi/build-openapi-document";
import { configureApiVersioning } from "./common/openapi/configure-api-versioning";

import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.validation";
import { AllExceptionsFilter } from "./common/http/all-exceptions.filter";
import { correlationIdMiddleware } from "./common/http/correlation-id.middleware";
import {
  LogErrorReporter,
  LogSpanExporter,
  eventLoopDelayMonitor,
  reportError,
  setErrorReporter,
  setSpanExporter,
  structuredNestLogger,
} from "./common/observability";
import { ResponseTransformInterceptor } from "./common/interceptors/response-transform.interceptor";
import { resolveAdmissionConfig } from "./common/admission/admission.config";
import { logger } from "./common/logger/logger.service";
import { shutdownGate } from "./health/shutdown-gate";

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
  eventLoopDelayMonitor.start();

  // Shared with `src/scripts/generate-openapi.ts`, which had no versioning at
  // all — so `/v2/users` was served here and documented nowhere.
  configureApiVersioning(app, { runtimeAliases: true });

  // Declared, never guessed. Until this line existed nothing in the process set
  // `trust proxy`, so `req.ip` was the socket address while the rate limiter and every
  // abuse counter read the forwarded-for header's leftmost hop instead — the one entry the
  // CLIENT writes. Express counts trusted hops from the RIGHT, so with this set the header
  // can no longer move `req.ip`, and with no hops declared it is ignored entirely.
  app.set("trust proxy", trustProxySetting());

  app.use(helmet());
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      "Permissions-Policy",
      "geolocation=(), microphone=(), camera=(), payment=(), usb=(), fullscreen=(self)",
    );
    next();
  });
  // Declared, not defaulted: threshold, brotli quality, the already-compressed
  // exclusions and the secret opt-out all live in one reviewable file.
  app.use(compression(httpCompressionOptions()));
  app.enableShutdownHooks();
  // Ahead of routing so a request arriving after the drain has begun is refused
  // before it takes a connection, and one already running is counted so
  // `beforeApplicationShutdown` can wait for it.
  app.use(shutdownGate);
  app.use(correlationIdMiddleware);

  app.enableCors({
    origin: isDevelopment
      ? (origin, callback) => {
          callback(null, !origin || config.corsOrigins.includes(origin));
        }
      : config.corsOrigins,
    credentials: true,
    exposedHeaders: ["x-correlation-id", "x-request-id", "traceparent"],
  });

  const admission = resolveAdmissionConfig(process.env);

  app.useBodyParser("json", { limit: admission.maxBodyBytes });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.useBodyParser("urlencoded", {
    extended: true,
    limit: Math.floor(admission.maxBodyBytes / 3),
  });

  if (isDevelopment) {
    const built = buildOpenApiDocument(app);
    logger.info(
      `OpenAPI: exposure recorded on ${built.stamped} operation(s), ${built.undeclared} undeclared; ` +
        `zod contracts on ${built.contractsApplied}, ${built.unconvertible.length} unconvertible`,
    );
    SwaggerModule.setup("api/docs", app, built.document);
  }

  await app.listen(config.PORT);
}

bootstrap().catch((error: unknown) => {
  logger.error("Fatal: application bootstrap failed", { error: describeError(error) });
  process.exit(1);
});
