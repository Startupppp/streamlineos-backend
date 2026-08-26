import { ConflictException } from "@nestjs/common";
import { ProfilesService } from "../profiles.service";
import { logger } from "../../../../common/logger/logger.service";
import type { CreateProfileInput } from "../dto/runs.schemas";

jest.mock("../../../../common/logger/logger.service", () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock("../../lib/payroll-payee-eligibility", () => ({
  assertPayrollPayeeEligible: jest.fn().mockResolvedValue(undefined),
  assertPayrollWorkerPayeeEligible: jest.fn().mockResolvedValue({ workerId: "w1", userId: "u1" }),
}));

const ORG = "org-1";
const UID = "user-1";
const WID = "w1";

function makeTx(onInsert: () => Promise<unknown>) {
  const limit = jest.fn().mockResolvedValue([]);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  return {
    select: jest.fn().mockReturnValue({ from }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue([]) }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({ returning: jest.fn().mockImplementation(onInsert) }),
    }),
  };
}

function makeDb(tx: ReturnType<typeof makeTx>) {
  return {
    transaction: jest.fn().mockImplementation((cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
}

const audit = { log: jest.fn() };

const baseBody: CreateProfileInput = {
  effectiveFrom: "2099-01-01",
  annualCtc: "600000",
  workerType: "EMPLOYEE",
  currency: "INR",
  components: [],
};

describe("ProfilesService insert error handling", () => {
  beforeEach(() => jest.clearAllMocks());

  it("createProfile: logs error and rethrows on a non-23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("connection reset"), { code: "08006" });
    const svc = new ProfilesService(makeDb(makeTx(() => Promise.reject(dbErr))) as never, audit as never);

    await expect(svc.createProfile(ORG, UID, "actor-1", baseBody)).rejects.toBe(dbErr);
    expect(
      (logger.error as jest.Mock).mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("createEmployeeProfile"),
      ),
    ).toBe(true);
  });

  it("createProfile: throws ConflictException on a 23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("unique violation"), { code: "23505" });
    const svc = new ProfilesService(makeDb(makeTx(() => Promise.reject(dbErr))) as never, audit as never);

    await expect(svc.createProfile(ORG, UID, "actor-1", baseBody)).rejects.toBeInstanceOf(ConflictException);
    expect(logger.error as jest.Mock).not.toHaveBeenCalled();
  });

  it("createProfileByWorker: logs error and rethrows on a non-23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("rls deny"), { code: "42501" });
    const svc = new ProfilesService(makeDb(makeTx(() => Promise.reject(dbErr))) as never, audit as never);

    await expect(svc.createProfileByWorker(ORG, WID, "actor-1", baseBody)).rejects.toBe(dbErr);
    expect(
      (logger.error as jest.Mock).mock.calls.some(([msg]) =>
        typeof msg === "string" && msg.includes("createWorkerProfile"),
      ),
    ).toBe(true);
  });

  it("createProfileByWorker: throws ConflictException on a 23505 insert failure", async () => {
    const dbErr = Object.assign(new Error("unique violation"), { code: "23505" });
    const svc = new ProfilesService(makeDb(makeTx(() => Promise.reject(dbErr))) as never, audit as never);

    await expect(svc.createProfileByWorker(ORG, WID, "actor-1", baseBody)).rejects.toBeInstanceOf(ConflictException);
    expect(logger.error as jest.Mock).not.toHaveBeenCalled();
  });
});
