import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Controller, Module, Post } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import request from "supertest";
import { resolveAdmissionConfig } from "../../../src/common/admission/admission.config";

const BACKEND_ROOT = resolve(__dirname, "../../..");
const MAIN_TS = readFileSync(resolve(BACKEND_ROOT, "src/main.ts"), "utf8");

const ALLOWED_ORIGIN = "https://app.allowed.example";
const HOSTILE_ORIGIN = "https://evil.example";
const BODY_LIMIT_BYTES = 1024;

@Controller()
class EchoController {
  @Post("echo")
  echo(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [EchoController] })
class EchoModule {}

type Ordering = "cors-first" | "body-parser-first";

async function buildApp(
  ordering: Ordering,
  options: { helmet?: boolean } = {},
): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(EchoModule, {
    bodyParser: false,
    logger: false,
  });

  if (options.helmet === true) app.use(helmet());

  const registerCors = (): void => {
    app.enableCors({ origin: [ALLOWED_ORIGIN], credentials: true });
  };
  const registerBodyParser = (): void => {
    app.useBodyParser("json", { limit: BODY_LIMIT_BYTES });
  };

  if (ordering === "cors-first") {
    registerCors();
    registerBodyParser();
  } else {
    registerBodyParser();
    registerCors();
  }

  await app.init();
  return app;
}

function oversizedJson(): string {
  return JSON.stringify({ blob: "A".repeat(BODY_LIMIT_BYTES * 4) });
}

function smallJson(): string {
  return JSON.stringify({ blob: "A" });
}

describe("CORS is registered BEFORE the body parser", () => {
  let corsFirst: NestExpressApplication;
  let bodyParserFirst: NestExpressApplication;

  beforeAll(async () => {
    corsFirst = await buildApp("cors-first");
    bodyParserFirst = await buildApp("body-parser-first");
  });

  afterAll(async () => {
    await corsFirst.close();
    await bodyParserFirst.close();
  });

  it("rejects an oversized body with 413 in both orderings — the status alone cannot tell them apart", async () => {
    const a = await request(corsFirst.getHttpServer())
      .post("/echo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send(oversizedJson());
    const b = await request(bodyParserFirst.getHttpServer())
      .post("/echo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send(oversizedJson());

    expect(a.status).toBe(413);
    expect(b.status).toBe(413);
  });

  it("BITE: body parser first — the 413 carries no CORS header, so the browser reports an unexplained network error", async () => {
    const response = await request(bodyParserFirst.getHttpServer())
      .post("/echo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send(oversizedJson());

    expect(response.status).toBe(413);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("CORS first — the 413 still carries the CORS header, so the client can read the real status", async () => {
    const response = await request(corsFirst.getHttpServer())
      .post("/echo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send(oversizedJson());

    expect(response.status).toBe(413);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
  });

  it("main.ts registers enableCors before every useBodyParser call", () => {
    const corsAt = MAIN_TS.indexOf("app.enableCors(");
    const bodyParserAt = MAIN_TS.indexOf("app.useBodyParser(");
    const lastBodyParserAt = MAIN_TS.lastIndexOf("app.useBodyParser(");

    expect(corsAt).toBeGreaterThan(-1);
    expect(bodyParserAt).toBeGreaterThan(-1);
    expect({ corsBeforeFirstParser: corsAt < bodyParserAt, corsBeforeLastParser: corsAt < lastBodyParserAt }).toEqual({
      corsBeforeFirstParser: true,
      corsBeforeLastParser: true,
    });
  });

  it("main.ts creates the app with bodyParser:false so no implicit parser can precede CORS", () => {
    expect(MAIN_TS).toMatch(/bodyParser:\s*false/);
  });
});

describe("CORS origin allowlist", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await buildApp("cors-first");
  });
  afterAll(async () => {
    await app.close();
  });

  it("echoes the allowlisted origin back with credentials enabled", async () => {
    const response = await request(app.getHttpServer())
      .post("/echo")
      .set("Origin", ALLOWED_ORIGIN)
      .set("Content-Type", "application/json")
      .send(smallJson());

    expect(response.status).toBe(201);
    expect(response.headers["access-control-allow-origin"]).toBe(ALLOWED_ORIGIN);
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("BITE: a hostile origin gets no allow-origin header", async () => {
    const response = await request(app.getHttpServer())
      .post("/echo")
      .set("Origin", HOSTILE_ORIGIN)
      .set("Content-Type", "application/json")
      .send(smallJson());

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("a preflight from a hostile origin is not approved", async () => {
    const response = await request(app.getHttpServer())
      .options("/echo")
      .set("Origin", HOSTILE_ORIGIN)
      .set("Access-Control-Request-Method", "POST");

    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("main.ts never configures a wildcard origin, and credentials + wildcard never co-exist", () => {
    expect(MAIN_TS).not.toMatch(/origin:\s*["'`]\*["'`]/);
    expect(MAIN_TS).not.toMatch(/origin:\s*true/);
    expect(MAIN_TS).toMatch(/config\.corsOrigins/);
  });
});

describe("Security response headers", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await buildApp("cors-first", { helmet: true });
  });
  afterAll(async () => {
    await app.close();
  });

  it("helmet sets CSP, nosniff, frame denial and referrer policy, and strips x-powered-by", async () => {
    const response = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(smallJson());

    expect(response.headers["content-security-policy"]).toBeDefined();
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-powered-by"]).toBeUndefined();
  });

  it("BITE: without helmet the same app leaks x-powered-by and sets no CSP", async () => {
    const bare = await buildApp("cors-first");
    const response = await request(bare.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(smallJson());

    expect(response.headers["content-security-policy"]).toBeUndefined();
    expect(response.headers["x-powered-by"]).toBe("Express");
    await bare.close();
  });

  it("main.ts installs helmet and a Permissions-Policy that denies camera, microphone and geolocation", () => {
    expect(MAIN_TS).toMatch(/app\.use\(helmet\(\)\)/);
    expect(MAIN_TS).toContain("Permissions-Policy");
    for (const feature of ["geolocation=()", "microphone=()", "camera=()", "payment=()"]) {
      expect(MAIN_TS).toContain(feature);
    }
  });
});

describe("Payload limits", () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    app = await buildApp("cors-first");
  });
  afterAll(async () => {
    await app.close();
  });

  it("accepts a body under the limit and rejects one over it", async () => {
    const under = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(smallJson());
    const over = await request(app.getHttpServer())
      .post("/echo")
      .set("Content-Type", "application/json")
      .send(oversizedJson());

    expect(under.status).toBe(201);
    expect(over.status).toBe(413);
  });

  it("the admission config supplies a bounded default body cap", () => {
    const config = resolveAdmissionConfig({});
    expect(config.maxBodyBytes).toBe(3_145_728);
    expect(config.maxBodyBytes).toBeLessThan(10_485_760);
  });

  it("an explicit ADMISSION_MAX_BODY_BYTES is honoured and a non-numeric value fails closed at boot", () => {
    expect(resolveAdmissionConfig({ ADMISSION_MAX_BODY_BYTES: "4096" }).maxBodyBytes).toBe(4096);
    expect(() => resolveAdmissionConfig({ ADMISSION_MAX_BODY_BYTES: "not-a-number" })).toThrow(
      /Invalid admission configuration/,
    );
    expect(() => resolveAdmissionConfig({ ADMISSION_MAX_BODY_BYTES: "0" })).toThrow(
      /Invalid admission configuration/,
    );
  });

  it("main.ts caps both the json and the urlencoded parser from that config", () => {
    expect(MAIN_TS).toMatch(/useBodyParser\("json",\s*\{\s*limit:\s*admission\.maxBodyBytes/);
    expect(MAIN_TS).toMatch(/useBodyParser\(\s*"urlencoded"[\s\S]*?limit:\s*Math\.floor\(admission\.maxBodyBytes/);
  });
});
