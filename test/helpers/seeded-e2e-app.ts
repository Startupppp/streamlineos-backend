import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { AppModule } from "src/app.module";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { JwtKeyringService } from "src/common/auth/jwt-keyring.service";
import * as schema from "src/db/schema";
import type { Db } from "src/db/drizzle.module";
import { assertDisposableDatabase } from "test/helpers/disposable-database";

export { assertDisposableDatabase };

export const SEEDED_HARNESS = "[seeded-e2e]" as const;

export interface SeededE2eApp {
  app: INestApplication;
  seedDb: Db;
  keyring: JwtKeyringService;
  close(): Promise<void>;
}

export async function createSeededE2eApp(): Promise<SeededE2eApp> {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error("DATABASE_URL must be set for seeded e2e tests");
  const target = assertDisposableDatabase(ownerUrl);
  if (!target.ok) throw new Error(`[seeded-e2e] ${target.reason}`);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.useGlobalFilters(new AllExceptionsFilter());
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
