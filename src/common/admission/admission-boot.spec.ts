import { Body, Controller, Get, Module, Post } from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionModule } from "./admission.module";
import { AdmissionService } from "./admission.service";
import { UseWorkClass } from "./work-class.decorator";

@Controller("probe")
class ProbeController {
  @Get()
  read(): { ok: boolean } {
    return { ok: true };
  }

  @Post()
  write(@Body() body: unknown): { received: boolean } {
    return { received: body !== undefined };
  }

  @Get("reserved")
  @UseWorkClass("authentication")
  reserved(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [AdmissionModule],
  controllers: [ProbeController],
  providers: [
    { provide: APP_GUARD, useClass: AdmissionGuard },
    { provide: APP_INTERCEPTOR, useClass: AdmissionInterceptor },
  ],
})
class ProbeAppModule {}

const ORIGIN = "http://localhost:3000";

describe("admission control resolves through real Nest DI and serves real HTTP", () => {
  let app: NestExpressApplication;
  let service: AdmissionService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeAppModule] }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    app.enableCors({ origin: [ORIGIN], credentials: true });
    app.useBodyParser("json", { limit: 1024 });
    service = moduleRef.get(AdmissionService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("boots, which is what proves the guard and interceptor are constructible", () => {
    expect(service).toBeInstanceOf(AdmissionService);
  });

  it("admits an ordinary request and returns the handler's response", async () => {
    await request(app.getHttpServer()).get("/probe").expect(200, { ok: true });
  });

  it("returns the in-flight count to zero after a served request", async () => {
    await request(app.getHttpServer()).get("/probe").expect(200);

    expect(service.snapshot().inFlight).toBe(0);
  });

  it("answers an oversized body with 413 that still carries its CORS header", async () => {
    const response = await request(app.getHttpServer())
      .post("/probe")
      .set("Origin", ORIGIN)
      .set("Content-Type", "application/json")
      .send({ blob: "x".repeat(4096) });

    expect(response.status).toBe(413);
    expect(response.headers["access-control-allow-origin"]).toBe(ORIGIN);
  });

  it("leaks no in-flight slot when the body parser rejects before the guard", () => {
    expect(service.snapshot().inFlight).toBe(0);
  });

  it.each(["/auth/nothing-is-mounted-here", "/../auth/login", "//auth/login"])(
    "consumes no capacity for %s, which reaches no handler",
    async (path) => {
      const response = await request(app.getHttpServer()).get(path);

      expect(response.status).toBe(404);
      expect(service.snapshot().inFlight).toBe(0);
    },
  );

  it("resolves a traversal to the handler it really reaches", async () => {
    await request(app.getHttpServer()).get("/auth/../probe").expect(200, { ok: true });

    expect(service.snapshot().inFlight).toBe(0);
  });
});

describe("admission control sheds over real HTTP", () => {
  let app: NestExpressApplication;
  let service: AdmissionService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ProbeAppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>();
    service = moduleRef.get(AdmissionService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("refuses a sheddable route with 503 and retry information once saturated", async () => {
    const config = { ...service.snapshot() };
    for (let i = 0; i < config.maxConcurrent; i++) service.tryAdmit("authentication", `filler-${String(i)}`);

    const response = await request(app.getHttpServer()).get("/probe");

    expect(response.status).toBe(503);
    expect(response.headers["retry-after"]).toBeDefined();
    expect(Number(response.headers["retry-after"])).toBeGreaterThan(0);
    expect(response.body.retryAfterSeconds ?? response.body.message?.retryAfterSeconds).toBeDefined();
  });

  it("refuses a traversal that only looks reserved, so a crafted path cannot jump the queue", async () => {
    const { inFlight } = service.snapshot();
    for (let i = 0; i < inFlight; i++) service.release(`filler-${String(i)}`);
    for (let i = 0; i < service.snapshot().maxConcurrent; i++)
      service.tryAdmit("authentication", `filler-${String(i)}`);

    const crafted = await request(app.getHttpServer()).get("/auth/../probe");

    expect(crafted.status).toBe(503);
  });

  it("serves the reserved route again as soon as capacity is released", async () => {
    const { inFlight } = service.snapshot();
    for (let i = 0; i < inFlight; i++) service.release(`filler-${String(i)}`);

    await request(app.getHttpServer()).get("/probe/reserved").expect(200, { ok: true });
  });
});
