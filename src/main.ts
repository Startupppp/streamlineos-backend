import "reflect-metadata";
import { setDefaultResultOrder } from "node:dns";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { validateEnv } from "./config/env.validation";
import { AllExceptionsFilter } from "./common/http/all-exceptions.filter";
import { ResponseTransformInterceptor } from "./common/interceptors/response-transform.interceptor";

setDefaultResultOrder("ipv4first");

async function bootstrap(): Promise<void> {
  const config = validateEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: false,
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser("json", { limit: "3mb" });
  app.useBodyParser("urlencoded", { extended: true, limit: "1mb" });
  app.use(helmet());
  const isLocalDevOrigin = (origin: string): boolean =>
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
  app.enableCors({
    origin:
      config.NODE_ENV === "development"
        ? (origin, callback) => {
            callback(
              null,
              !origin ||
                isLocalDevOrigin(origin) ||
                config.corsOrigins.includes(origin),
            );
          }
        : config.corsOrigins,
    credentials: true,
  });
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseTransformInterceptor());
  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("StreamlineOS API")
    .setDescription("StreamlineOS platform REST API")
    .setVersion("1.0")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  await app.listen(config.PORT);
}

void bootstrap();
