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
import { EmailProviderService } from "src/modules/email/email.provider";
import { CapturingMailTransport } from "./mail-capture";

export { assertDisposableDatabase };

export const SEEDED_HARNESS = "[seeded-e2e]" as const;

export interface SeededE2eApp {
  app: INestApplication;
  seedDb: Db;
  /**
   * Outbound mail this run produced, captured in memory.
   *
   * The transport is overridden, so nothing reaches a provider. Assert against
   * this instead: `seeded.mail.to(addr)`, `.withSubject(...)`, `.last()`.
   */
  mail: CapturingMailTransport;
  keyring: JwtKeyringService;
  close(): Promise<void>;
}

export interface SeededE2eAppOptions {
  /**
   * Keep the received bytes on the request, as `main.ts` does.
   *
   * Only a handler that verifies an HMAC needs this, and such a handler cannot
   * be tested honestly without it: a signature covers the bytes the sender
   * sent, so a handler that signed `JSON.stringify(req.body)` would reject
   * every genuine delivery — and with no `rawBody` at all it reads the empty
   * string and refuses everything, which is a green suite for a dead endpoint.
   */
  rawBody?: boolean;
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

/** The name the HTTP-stack option was introduced under; the same shape. */
export type SeededE2eOptions = SeededE2eAppOptions;

export async function createSeededE2eApp(
  options: SeededE2eAppOptions = {},
): Promise<SeededE2eApp> {
  assertSeededProcessIsolation(process.env);
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error("DATABASE_URL must be set for seeded e2e tests");
  const target = assertDisposableDatabase(ownerUrl);
  if (!target.ok) throw new Error(`[seeded-e2e] ${target.reason}`);

  /**
   * Two payroll workers start sweeping on `onModuleInit` with no env gate and
   * no `.unref()` on their timers — unlike the notification and HR export
   * workers, which have both. Booting AppModule in a test therefore walks
   * every organisation in the database (hundreds on a shared dev branch,
   * each failing on a missing region) and holds the event loop open, which
   * turned a 60-second inventory suite into a 15-minute one and then a hang.
   *
   * Neutered here rather than in payroll: this branch is inventory-only, and
   * the harness is the right place to say "no background sweeps in tests".
   */
  const noopWorker = { onModuleInit: () => undefined, onModuleDestroy: () => undefined };

  /**
   * Mail never leaves the process.
   *
   * `jest-e2e-seeded.json` loads the real `.env` through `dotenv/config`, which
   * carries `EMAIL_PROVIDER=resend` and a live `RESEND_API_KEY`, and nothing
   * here stubbed the transport — so every seeded spec that sent mail spent real
   * Resend quota, and was one real-looking fixture address away from mailing a
   * stranger. Overriding the provider is also what makes "an email went to X
   * with subject Y" assertable at all; today no spec can say that, which is
   * likely why the live calls went unnoticed.
   *
   * The override is on `EmailProviderService`, which is the single chokepoint:
   * `buildEmailClients` — the only place a `Resend` or `SendMailClient` is
   * constructed — is called from its constructor and nowhere else, and with the
   * provider replaced by value that constructor never runs, so no client is
   * built and no key is read.
   */
  const mail = new CapturingMailTransport();

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PayrollJobsWorkerService)
    .useValue(noopWorker)
    .overrideProvider(PayrollCalendarReminderScheduler)
    .useValue(noopWorker)
    .overrideProvider(EmailProviderService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: options.rawBody === true });
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
    mail,
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
