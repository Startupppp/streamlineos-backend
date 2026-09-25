import { Controller, Get, INestApplication, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { AllExceptionsFilter } from "./all-exceptions.filter";
import { CORS_ALLOWED_HEADERS, corsOptions } from "./cors.config";

const ALLOWED_ORIGIN = "https://app.example.test";
const FOREIGN_ORIGIN = "https://evil.example.test";

@Controller("cors-probe")
class CorsProbeController {
  @Get()
  read(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [CorsProbeController] })
class CorsProbeModule {}

/**
 * The origin allowlist and the declared header set, over a real preflight.
 *
 * Nothing exercised CORS before, so the absence of `allowedHeaders` — which left
 * the cors package reflecting whatever the caller asked for — was invisible.
 */
describe("CORS", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const ref = await Test.createTestingModule({
      imports: [CorsProbeModule],
    }).compile();

    app = ref.createNestApplication();
    app.enableCors(
      corsOptions({ origins: [ALLOWED_ORIGIN], isDevelopment: false }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
  });

  afterAll(async () => app.close());

  it("echoes an allowlisted origin on a preflight and allows credentials", async () => {
    const res = await request(app.getHttpServer())
      .options("/cors-probe")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("does not echo an origin that is not on the allowlist", async () => {
    const res = await request(app.getHttpServer())
      .options("/cors-probe")
      .set("Origin", FOREIGN_ORIGIN)
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows the declared request headers", async () => {
    const res = await request(app.getHttpServer())
      .options("/cors-probe")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "authorization,idempotency-key");

    const allowed = (res.headers["access-control-allow-headers"] ?? "")
      .split(",")
      .map((header: string) => header.trim().toLowerCase());

    for (const header of CORS_ALLOWED_HEADERS) {
      expect(allowed).toContain(header);
    }
  });

  it("answers with the declared list rather than reflecting what the caller asked for", async () => {
    const res = await request(app.getHttpServer())
      .options("/cors-probe")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "x-smuggled-header");

    expect(
      (res.headers["access-control-allow-headers"] ?? "").toLowerCase(),
    ).not.toContain("x-smuggled-header");
  });

  it("still carries Access-Control-Allow-Origin on a 404 the exception filter writes", async () => {
    const res = await request(app.getHttpServer())
      .get("/no-such-route")
      .set("Origin", ALLOWED_ORIGIN);

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ code: "NOT_FOUND" });
    // Without this the browser reports a CORS failure and the client never sees
    // the envelope it was handed.
    expect(res.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });
});
