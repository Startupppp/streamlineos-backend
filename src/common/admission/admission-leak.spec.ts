import * as http from "node:http";
import {
  CanActivate,
  Controller,
  ExecutionContext,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  UseGuards,
} from "@nestjs/common";
import { APP_GUARD, APP_INTERCEPTOR } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { NestExpressApplication } from "@nestjs/platform-express";
import request from "supertest";
import { ModuleDisabledException } from "../http/api-exceptions";
import type { AdmissionConfig } from "./admission.config";
import { AdmissionGuard } from "./admission.guard";
import { AdmissionInterceptor } from "./admission.interceptor";
import { AdmissionModule } from "./admission.module";
import { AdmissionService } from "./admission.service";

/**
 * The production defaults, pinned here so the regression does not silently stop
 * reproducing when someone retunes the env.
 */
const CONFIG: AdmissionConfig = {
  maxConcurrent: 200,
  maxQueueDepth: 400,
  maxExecutionMs: 5_000,
  maxBodyBytes: 3_145_728,
  orgMaxConcurrent: 50,
  reservedFraction: 0.2,
  enabled: true,
};

/** Comfortably past orgMaxConcurrent, matching the 60-request field reproduction. */
const SEQUENTIAL_REQUESTS = 60;

type ProbeRequest = {
  headers: Record<string, string | string[] | undefined>;
  user?: { orgId: string };
};

function probeRequest(context: ExecutionContext): ProbeRequest {
  return context.switchToHttp().getRequest<ProbeRequest>();
}

/** Stands in for JwtAuthGuard: runs before AdmissionGuard, so the org bucket is real. */
@Injectable()
class StubAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = probeRequest(context);
    const orgId = req.headers["x-test-org"];
    if (typeof orgId === "string") req.user = { orgId };
    return true;
  }
}

/** Stands in for ModuleGuard: a global guard registered *after* AdmissionGuard. */
@Injectable()
class StubModuleGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (probeRequest(context).headers["x-test-module-off"] === "1")
      throw new ModuleDisabledException("inventory");
    return true;
  }
}

/** Stands in for PermissionGuard: controller-level, so it runs after every global guard. */
@Injectable()
class StubDenyPermissionGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException({ code: "FORBIDDEN", message: "Denied." });
  }
}

const hang: { entered?: () => void; finish?: () => void } = {};

@Controller("inventory")
class InventoryProbeController {
  @Get("stock")
  stock(): { ok: boolean } {
    return { ok: true };
  }

  @Get("denied")
  @UseGuards(StubDenyPermissionGuard)
  denied(): { ok: boolean } {
    return { ok: true };
  }

  @Get("boom")
  boom(): { ok: boolean } {
    throw new Error("handler exploded");
  }

  @Get("hang")
  hangs(): Promise<{ ok: boolean }> {
    return new Promise((resolve) => {
      hang.finish = () => resolve({ ok: true });
      hang.entered?.();
    });
  }
}

/** `access` is a reserved prefix, so admission skips both the shed threshold and the per-org cap. */
@Controller("access")
class ReservedProbeController {
  @Get("org-modules")
  @UseGuards(StubDenyPermissionGuard)
  listModules(): { ok: boolean } {
    return { ok: true };
  }
}

@Module({
  imports: [AdmissionModule],
  controllers: [InventoryProbeController, ReservedProbeController],
  providers: [
    StubDenyPermissionGuard,
    { provide: APP_GUARD, useClass: StubAuthGuard },
    { provide: APP_GUARD, useClass: AdmissionGuard },
    { provide: APP_GUARD, useClass: StubModuleGuard },
    { provide: APP_INTERCEPTOR, useClass: AdmissionInterceptor },
  ],
})
class ProbeAppModule {}

/** Fails with the count it actually saw, rather than as an opaque jest timeout. */
async function waitForInFlight(service: AdmissionService, target: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (service.snapshot().inFlight !== target) {
    if (Date.now() > deadline)
      throw new Error(
        `inFlight stayed at ${String(service.snapshot().inFlight)}, expected ${String(target)}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function buildProbeApp(): Promise<{
  app: NestExpressApplication;
  service: AdmissionService;
}> {
  const moduleRef = await Test.createTestingModule({ imports: [ProbeAppModule] })
    .overrideProvider(AdmissionService)
    .useValue(new AdmissionService(CONFIG))
    .compile();

  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return { app, service: moduleRef.get(AdmissionService) };
}

describe("admission control leaks no slot when a post-admission guard rejects", () => {
  let app: NestExpressApplication;
  let service: AdmissionService;

  beforeEach(async () => {
    ({ app, service } = await buildProbeApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns every slot after 60 sequential 402s from the module guard", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++) {
      const response = await request(app.getHttpServer())
        .get("/inventory/stock")
        .set("x-test-org", "org-402")
        .set("x-test-module-off", "1");

      expect(response.status).toBe(402);
      expect(response.body.code).toBe("MODULE_NOT_ENABLED");
    }

    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });

  it("returns every slot after 60 sequential 403s from a controller-level permission guard", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++) {
      const response = await request(app.getHttpServer())
        .get("/inventory/denied")
        .set("x-test-org", "org-403");

      expect(response.status).toBe(403);
    }

    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });

  it("returns every slot after 60 sequential throws from the handler", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++) {
      const response = await request(app.getHttpServer())
        .get("/inventory/boom")
        .set("x-test-org", "org-throw");

      expect(response.status).toBe(500);
    }

    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });

  it("still serves the org after its rejected requests, rather than locking it out", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++)
      await request(app.getHttpServer())
        .get("/inventory/stock")
        .set("x-test-org", "org-recover")
        .set("x-test-module-off", "1")
        .expect(402);

    await request(app.getHttpServer())
      .get("/inventory/stock")
      .set("x-test-org", "org-recover")
      .expect(200, { ok: true });
  });

  it("returns every slot on a reserved path, which has no per-org ceiling to stop the bleed", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++)
      await request(app.getHttpServer())
        .get("/access/org-modules")
        .set("x-test-org", "org-reserved")
        .expect(403);

    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });

  it("returns every slot for unauthenticated traffic, which shares the __public__ bucket", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++)
      await request(app.getHttpServer())
        .get("/inventory/stock")
        .set("x-test-module-off", "1")
        .expect(402);

    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });

  it("does not let one org's rejected requests shed another org", async () => {
    for (let i = 0; i < SEQUENTIAL_REQUESTS; i++)
      await request(app.getHttpServer())
        .get("/inventory/denied")
        .set("x-test-org", "org-noisy")
        .expect(403);

    await request(app.getHttpServer())
      .get("/inventory/stock")
      .set("x-test-org", "org-quiet")
      .expect(200, { ok: true });
  });
});

describe("admission control gives the slot back when the client hangs up", () => {
  let app: NestExpressApplication;
  let service: AdmissionService;

  beforeAll(async () => {
    ({ app, service } = await buildProbeApp());
    await app.listen(0);
  });

  afterAll(async () => {
    hang.finish?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.close();
  });

  it("releases at the abort, not when the abandoned handler finally settles", async () => {
    const port = Number(new URL(await app.getUrl()).port);
    const entered = new Promise<void>((resolve) => {
      hang.entered = resolve;
    });

    const clientRequest = http.request({ host: "127.0.0.1", port, path: "/inventory/hang" });
    // Destroying the socket is the point of this test, so its client-side error is expected.
    clientRequest.on("error", () => undefined);
    clientRequest.end();

    await entered;
    expect(service.snapshot().inFlight).toBe(1);

    clientRequest.destroy();

    await waitForInFlight(service, 0);
    expect(service.snapshot()).toMatchObject({ inFlight: 0, orgMapSize: 0 });
  });
});
