import { ConflictException } from "@nestjs/common";
import { PayrollEntitiesService } from "../entities.service";
import { logger } from "../../../../common/logger/logger.service";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const ORG = "org-1";

function makeDb(onInsert: () => Promise<unknown>) {
  return {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockImplementation(onInsert),
      }),
    }),
  };
}

const body = { legalName: "Acme Ltd" };

describe("PayrollEntitiesService create error handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("logs error and rethrows on a non-23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("connection reset"), { code: "08006" });
    const svc = new PayrollEntitiesService(makeDb(() => Promise.reject(dbErr)) as never);

    await expect(svc.create(ORG, "actor-1", body)).rejects.toBe(dbErr);
    expect(logger.error as jest.Mock).toHaveBeenCalledWith(
      "entities.create: insert failed unexpectedly",
      expect.objectContaining({ cause: "connection reset" }),
    );
  });

  it("throws ConflictException on a 23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("unique violation"), { code: "23505" });
    const svc = new PayrollEntitiesService(makeDb(() => Promise.reject(dbErr)) as never);

    await expect(svc.create(ORG, "actor-1", body)).rejects.toBeInstanceOf(ConflictException);
    expect(logger.error as jest.Mock).not.toHaveBeenCalled();
  });
});
