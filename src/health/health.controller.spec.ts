import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { CacheService, REDIS } from "../common/cache/cache.service";
import { DB_POOL_CONFIG, DRIZZLE } from "../db/drizzle.constants";
import { poolTelemetry } from "../db/pool-telemetry";
import { resolvePoolConfig } from "../db/pool.config";
import { HealthController } from "./health.controller";
import { shutdownState } from "./shutdown-state";

const POOL_CONFIG = resolvePoolConfig({
  NODE_ENV: "test",
  APP_DATABASE_URL: "postgres://app:pw@ep-x-pooler.us-east-2.aws.neon.tech/db",
});

describe("HealthController", () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;
  const originalSettling = process.env.SHUTDOWN_SETTLING_DELAY_MS;

  async function createController(
    execute: () => Promise<unknown>,
    droppedInvalidations = 0,
  ): Promise<HealthController> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DRIZZLE, useValue: { execute } },
        { provide: DB_POOL_CONFIG, useValue: POOL_CONFIG },
        { provide: REDIS, useValue: null },
        { provide: CacheService, useValue: { droppedInvalidationCount: droppedInvalidations } },
      ],
    }).compile();
    return module.get(HealthController);
  }

  beforeEach(() => {
    process.env.SHUTDOWN_SETTLING_DELAY_MS = "0";
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = originalSecret;
    if (originalSettling === undefined) delete process.env.SHUTDOWN_SETTLING_DELAY_MS;
    else process.env.SHUTDOWN_SETTLING_DELAY_MS = originalSettling;
    poolTelemetry.reset();
    shutdownState.reset();
    jest.useRealTimers();
  });

  describe("liveness is shallow", () => {
    it("answers without touching the database", async () => {
      const execute = jest.fn().mockRejectedValue(new Error("database unavailable"));
      const controller = await createController(execute);

      expect(controller.health()).toEqual({ status: "ok" });
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("readiness is dependency-aware", () => {
    it("is ready when the database responds", async () => {
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      const snapshot = await controller.ready();

      expect(snapshot.status).toBe("ready");
      expect(snapshot.dependencies.find((entry) => entry.name === "database")?.state).toBe("up");
    });

    it("returns HTTP 503 when the database is unreachable", async () => {
      const controller = await createController(
        jest.fn().mockRejectedValue(new Error("database unavailable")),
      );

      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it("names the failing dependency in the 503 body rather than a bare message", async () => {
      const controller = await createController(
        jest.fn().mockRejectedValue(new Error("terminating connection due to administrator command")),
      );

      await expect(controller.ready()).rejects.toMatchObject({
        response: {
          readiness: {
            status: "unready",
            dependencies: expect.arrayContaining([
              expect.objectContaining({
                name: "database",
                state: "down",
                required: true,
                detail: "terminating connection due to administrator command",
              }),
            ]),
          },
        },
      });
    });

    it("reports the cache as skipped, not failed, when Redis is unconfigured", async () => {
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      const snapshot = await controller.ready();

      expect(snapshot.dependencies.find((entry) => entry.name === "cache")).toMatchObject({
        state: "skipped",
        required: false,
      });
      expect(snapshot.status).toBe("ready");
    });

    it("probes the database once across 25 readiness calls", async () => {
      const execute = jest.fn().mockResolvedValue(undefined);
      const controller = await createController(execute);

      for (let i = 0; i < 25; i++) await controller.ready();

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe("internal diagnostics", () => {
    it("refuses pool telemetry without the internal secret", async () => {
      process.env.INTERNAL_API_SECRET = "internal-secret-value";
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      await expect(controller.databasePool(undefined)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      await expect(controller.databasePool("wrong")).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it("refuses pool telemetry when no internal secret is configured", async () => {
      delete process.env.INTERNAL_API_SECRET;
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      await expect(controller.databasePool("anything")).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it("reports the endpoint and pool depth to an authorised caller", async () => {
      process.env.INTERNAL_API_SECRET = "internal-secret-value";
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      const result = await controller.databasePool("internal-secret-value");

      expect(result.status).toBe("ok");
      expect(result.endpoint).toEqual({
        host: "ep-x-pooler.us-east-2.aws.neon.tech",
        pooled: true,
        role: "application",
      });
      expect(result.pool.inFlight).toBe(0);
      expect(result.pool.waiting).toBe(0);
    });

    it("refuses the workflow backlog without the internal secret", async () => {
      process.env.INTERNAL_API_SECRET = "internal-secret-value";
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      await expect(controller.workflows(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe("shutdown sequencing", () => {
    it("ready returns 503 as soon as the drain begins, before anything is refused", async () => {
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      shutdownState.beginDrain();

      await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(shutdownState.acceptsNewWork()).toBe(true);
    });

    it("health returns ok during shutdown so the orchestrator does not kill the process mid-drain", async () => {
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      await controller.beforeApplicationShutdown("SIGTERM");

      expect(controller.health()).toEqual({ status: "ok" });
    });

    it("ready is healthy before shutdown begins", async () => {
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      await expect(controller.ready()).resolves.toMatchObject({ status: "ready" });
    });

    it("stops accepting new work only after the settling delay has elapsed", async () => {
      jest.useFakeTimers();
      process.env.SHUTDOWN_SETTLING_DELAY_MS = "5000";
      const controller = await createController(jest.fn().mockResolvedValue(undefined));

      const hook = controller.beforeApplicationShutdown("SIGTERM");
      expect(shutdownState.currentPhase).toBe("draining");
      expect(shutdownState.acceptsNewWork()).toBe(true);

      jest.runAllTimers();
      await hook;

      expect(shutdownState.currentPhase).toBe("closed");
      expect(shutdownState.acceptsNewWork()).toBe(false);
    });

    it("waits for in-flight work before the hook resolves", async () => {
      process.env.SHUTDOWN_SETTLING_DELAY_MS = "0";
      const controller = await createController(jest.fn().mockResolvedValue(undefined));
      shutdownState.enter();

      let settled = false;
      const hook = controller.beforeApplicationShutdown("SIGTERM").then(() => {
        settled = true;
      });

      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      expect(shutdownState.currentPhase).toBe("closed");
      expect(settled).toBe(false);

      shutdownState.leave();
      await hook;

      expect(settled).toBe(true);
      expect(shutdownState.snapshot().inFlight).toBe(0);
    });
  });
});
