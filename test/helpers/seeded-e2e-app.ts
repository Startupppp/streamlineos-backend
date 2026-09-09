import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { SignJWT } from "jose";
import { AppModule } from "src/app.module";
import { AllExceptionsFilter } from "src/common/http/all-exceptions.filter";
import { INTERNAL_TOKEN_AUDIENCE, INTERNAL_TOKEN_ISSUER } from "src/common/auth/backend-claims";
import * as schema from "src/db/schema";
import type { Db } from "src/db/drizzle.module";

export const SEEDED_HARNESS = "[seeded-e2e]" as const;

export interface SeededE2eApp {
  app: INestApplication;
  seedDb: Db;
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
}

export async function createSeededE2eApp(
  options: SeededE2eAppOptions = {},
): Promise<SeededE2eApp> {
  const ownerUrl = process.env.DATABASE_URL;
  if (!ownerUrl) throw new Error("DATABASE_URL must be set for seeded e2e tests");
  process.env.BACKEND_JWT_SECRET ??= "x".repeat(44);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication({ rawBody: options.rawBody === true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const seedClient = postgres(ownerUrl, { prepare: false, max: 3 });
  const seedDb: Db = drizzle(seedClient, { schema });

  return {
    app,
    seedDb,
    async close() {
      await app.close();
      await seedClient.end({ timeout: 5 });
    },
  };
}

export async function signSeededToken(
  userId: string,
  orgId: string,
  sessionId = `seeded-${crypto.randomUUID()}`,
): Promise<string> {
  const secret = process.env.BACKEND_JWT_SECRET ?? "x".repeat(44);
  return new SignJWT({ sub: userId, orgId, sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(INTERNAL_TOKEN_ISSUER)
    .setAudience(INTERNAL_TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(new TextEncoder().encode(secret));
}
