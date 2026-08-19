import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DB_POOL_CONFIG, DRIZZLE } from "../db/drizzle.constants";
import { poolTelemetry } from "../db/pool-telemetry";
import { resolvePoolConfig } from "../db/pool.config";
import { HealthController } from "./health.controller";

const POOL_CONFIG = resolvePoolConfig({
  NODE_ENV: "test",
  APP_DATABASE_URL: "postgres://app:pw@ep-x-pooler.us-east-2.aws.neon.tech/db",
});

describe("HealthController", () => {
  const originalSecret = process.env.INTERNAL_API_SECRET;

  async function createController(execute: () => Promise<unknown>): Promise<HealthController> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: DRIZZLE, useValue: { execute } },
        { provide: DB_POOL_CONFIG, useValue: POOL_CONFIG },
      ],
    }).compile();
    return module.get(HealthController);
  }

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = originalSecret;
    poolTelemetry.reset();
  });

  it("returns ready when the database is reachable", async () => {
    const controller = await createController(jest.fn().mockResolvedValue(undefined));

    await expect(controller.ready()).resolves.toEqual({ status: "ready" });
  });

  it("returns HTTP 503 when the database is unreachable", async () => {
    const controller = await createController(
      jest.fn().mockRejectedValue(new Error("database unavailable")),
    );

    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("refuses pool telemetry without the internal secret", async () => {
    process.env.INTERNAL_API_SECRET = "internal-secret-value";
    const controller = await createController(jest.fn().mockResolvedValue(undefined));

    await expect(controller.databasePool(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.databasePool("wrong")).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("refuses pool telemetry when no internal secret is configured", async () => {
    delete process.env.INTERNAL_API_SECRET;
    const controller = await createController(jest.fn().mockResolvedValue(undefined));

    await expect(controller.databasePool("anything")).rejects.toBeInstanceOf(UnauthorizedException);
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
});
