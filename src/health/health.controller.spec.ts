import { ServiceUnavailableException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../db/drizzle.constants";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  async function createController(execute: () => Promise<unknown>): Promise<HealthController> {
    const module = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: DRIZZLE, useValue: { execute } }],
    }).compile();
    return module.get(HealthController);
  }

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
});
