import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Controller, Post, Module, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { corsOptions } from "./cors.config";
import { shutdownGate } from "../../health/shutdown-gate";
import { shutdownState } from "../../health/shutdown-state";

const ORIGIN = "https://app.example.test";

@Controller("chat/saved")
class ProbeController {
  @Post(":messageId")
  save(): { ok: true } {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

/**
 * CHAT-011: a response written by middleware that runs BEFORE the cors middleware carries no
 * Access-Control-Allow-Origin, so the browser reports a CORS/network failure and the client
 * never sees the status. `main.ts` registered cors after helmet, compression, the shutdown gate
 * and the correlation middleware.
 */
describe("CORS is registered before any middleware that can answer on its own", () => {
  it("main.ts calls enableCors before the first app.use", () => {
    const main = readFileSync(join(__dirname, "../../main.ts"), "utf8");
    const cors = main.indexOf("app.enableCors(");
    expect(cors).toBeGreaterThan(-1);
    expect(cors).toBeLessThan(main.indexOf("app.use("));
  });

  describe("a draining instance's 503", () => {
    let app: INestApplication;

    beforeAll(async () => {
      const ref = await Test.createTestingModule({ imports: [ProbeModule] }).compile();
      app = ref.createNestApplication();
      app.enableCors(corsOptions({ origins: [ORIGIN], isDevelopment: false }));
      app.use(shutdownGate);
      await app.init();
    });

    afterAll(async () => {
      shutdownState.reset();
      await app.close();
    });

    it("is readable cross-origin, so the client sees a retryable 503 rather than a CORS error", async () => {
      shutdownState.stopAccepting();
      const res = await request(app.getHttpServer()).post("/chat/saved/5").set("Origin", ORIGIN);

      expect(res.status).toBe(503);
      expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    });
  });

  // SEC-HRMS-005: a 429's Retry-After was unreadable cross-origin, so clients backed off 1s.
  it("lets a cross-origin client read Retry-After", () => {
    const options = corsOptions({ origins: [ORIGIN], isDevelopment: false });
    expect(options.exposedHeaders).toEqual(expect.arrayContaining(["retry-after"]));
  });
});
