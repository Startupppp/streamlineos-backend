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
import { EmailProviderService } from "src/modules/email/email.provider";
import { CapturingMailTransport } from "./mail-capture";

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
    .overrideProvider(EmailProviderService)
    .useValue(mail)
    .compile();
  const app = moduleRef.createNestApplication({ rawBody: options.rawBody === true });
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.init();

  const seedClient = postgres(ownerUrl, { prepare: false, max: 3 });
  const seedDb: Db = drizzle(seedClient, { schema });

  return {
    app,
    seedDb,
    mail,
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
