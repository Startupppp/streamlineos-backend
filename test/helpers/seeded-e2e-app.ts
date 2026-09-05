import { VersioningType, type INestApplication } from "@nestjs/common";
import { VERSION_NEUTRAL } from "@nestjs/common/interfaces";
import { Test } from "@nestjs/testing";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { AppModule } from "src/app.module";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { ResponseTransformInterceptor } from "src/common/interceptors/response-transform.interceptor";
import { API_VERSION_CURRENT } from "src/common/http/api-version";
import { JwtKeyringService } from "src/common/auth/jwt-keyring.service";
import * as schema from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { assertDisposableDatabase } from "test/helpers/disposable-database";
import { assertSeededProcessIsolation } from "test/helpers/seeded-process-environment";
import { PayrollJobsWorkerService } from "src/modules/payroll/jobs/payroll-jobs-worker.service";
import { PayrollCalendarReminderScheduler } from "src/modules/payroll/insights/payroll-calendar-reminder.scheduler";

export { assertDisposableDatabase };

export const SEEDED_HARNESS = "[seeded-e2e]" as const;

export interface SeededE2eApp {
  app: INestApplication;
  seedDb: Db;
  keyring: JwtKeyringService;
  close(): Promise<void>;
}

export interface SeededE2eOptions {
  /**
   * Reproduce `main.ts`'s HTTP layer — URI versioning and `ResponseTransformInterceptor`.
   *
   * Off by default, because every existing seeded spec asserts against the shape it already gets
   * and the envelope interceptor changes it. On for a spec that MEASURES the response rather than
   * asserting on it: response bytes taken without the envelope are bytes of a payload the
   * application never actually sends, and a route the frontend reaches at /v1/... is a route this
   * harness would otherwise 404 on and record as unmeasurable.
   *
   * `compression()` is deliberately NOT reproduced: a gzip ratio is a property of the payload's
   * entropy and of the deployment, so recording it would make the byte figure un-reproducible.
   */
  readonly mirrorHttpStack?: boolean;
}

export async function createSeededE2eApp(options: SeededE2eOptions = {}): Promise<SeededE2eApp> {
  assertSeededProcessIsolation(process.env);
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error("DATABASE_URL must be set for seeded e2e tests");
  const target = assertDisposableDatabase(ownerUrl);
  if (!target.ok) throw new Error(`[seeded-e2e] ${target.reason}`);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PayrollJobsWorkerService).useValue({})
    .overrideProvider(PayrollCalendarReminderScheduler).useValue({})
    .compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
  if (options.mirrorHttpStack === true) {
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: [API_VERSION_CURRENT, VERSION_NEUTRAL] });
    app.useGlobalInterceptors(new ResponseTransformInterceptor());
  }
  await app.init();

  const seedClient = postgres(ownerUrl, { prepare: false, max: 3 });
  const seedDb: Db = drizzle(seedClient, { schema });

  const keyring = app.get(JwtKeyringService);
  if (!keyring.isReady())
    throw new Error(
      "[seeded-e2e] JwtKeyringService loaded no keys — set AUTH_SIGNING_KEYS. " +
        "Without it every request returns 401 and the failure reads as an authorization defect.",
    );

  return {
    app,
    seedDb,
    keyring,
    async close() {
      await app.close();
      await seedClient.end({ timeout: 5 });
    },
  };
}

/**
 * Signs through the application's own keyring rather than forging a token: the backend
 * verifies EdDSA only, so the previous HS256 `BACKEND_JWT_SECRET` token was rejected and
 * every seeded request returned 401.
 */
export async function signSeededToken(
  seeded: SeededE2eApp,
  userId: string,
  orgId: string,
  sessionId = `seeded-${crypto.randomUUID()}`,
): Promise<string> {
  return seeded.keyring.signToken({ sub: userId, orgId, sessionId });
}
