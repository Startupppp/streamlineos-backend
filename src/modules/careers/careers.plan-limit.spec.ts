import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { CareersService } from "./careers.service";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";
const JOB_ID = 5;

const FORBIDDEN_STRINGS = ["quota", "QUOTA_EXCEEDED", "plan", "limit", "402"];

const mockTxBuilder = (existingCandidate: unknown, existingApplication: unknown) => ({
  query: {
    candidates: { findFirst: jest.fn().mockResolvedValue(existingCandidate) },
    candidateApplications: { findFirst: jest.fn().mockResolvedValue(existingApplication) },
  },
  insert: jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    }),
  }),
  execute: jest.fn().mockResolvedValue([]),
});

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

function makeDb(): Db {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ id: JOB_ID, orgId: ORG }]),
        }),
      }),
    }),
  } as unknown as Db;
}

const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };

function makeInput() {
  return {
    jobPostingId: JOB_ID,
    name: "Test User",
    email: "test@example.com",
    phone: undefined,
    linkedinUrl: undefined,
    coverLetter: undefined,
    resumeUrl: undefined,
    answers: {},
  } as Parameters<CareersService["apply"]>[0];
}

describe("CareersService.apply — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows application when quota is not exceeded for a new candidate", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = mockTxBuilder(null, null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

    const result = await svc.apply(makeInput());

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates", 1, tx);
    expect(result).toMatchObject({ id: 42 });
  });

  it("skips assertion when the candidate already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = mockTxBuilder({ id: 99 }, null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

    await svc.apply(makeInput());

    expect(assertWithinLimit).not.toHaveBeenCalled();
  });

  it("returns job_not_found without asserting when the job does not exist", async () => {
    const assertWithinLimit = jest.fn();
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;
    const svc = new CareersService(db, cache as never, { assertWithinLimit } as never);

    const result = await svc.apply(makeInput());

    expect(result).toEqual({ error: "job_not_found" });
    expect(assertWithinLimit).not.toHaveBeenCalled();
  });

  describe("quota exceeded — public boundary translation", () => {
    function makeExceededSvc() {
      const assertWithinLimit = jest
        .fn()
        .mockRejectedValue(
          new PaymentRequiredException({
            code: "QUOTA_EXCEEDED",
            message: "Your FREE plan allows 50 HR candidates and 50 are already in use. Upgrade to add more.",
            details: { limitKey: "hrCandidates", used: 50, limit: 50, upgradePath: "/settings/billing" },
          }),
        );
      const tx = mockTxBuilder(null, null);
      (runInTenantTransaction as jest.Mock).mockImplementation(
        async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      );
      const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);
      return { svc, tx, assertWithinLimit };
    }

    it("(a) still prevents the insert when quota is exhausted", async () => {
      const { svc, tx } = makeExceededSvc();

      await expect(svc.apply(makeInput())).rejects.toBeInstanceOf(BadRequestException);

      expect(tx.insert).not.toHaveBeenCalled();
    });

    it("(b) surfaces a neutral 400 with no billing vocabulary", async () => {
      const { svc } = makeExceededSvc();

      let caught: unknown;
      try {
        await svc.apply(makeInput());
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      const httpError = caught as BadRequestException;
      expect(httpError.getStatus()).toBe(400);
      const serialized = JSON.stringify(httpError.getResponse());
      for (const forbidden of FORBIDDEN_STRINGS) {
        expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
      }
    });

    it("(c) the underlying PlanLimitsService signal is untouched — it still rejects with the real PaymentRequiredException", async () => {
      const { assertWithinLimit } = makeExceededSvc();

      await expect(assertWithinLimit(ORG, "hrCandidates", 1, {})).rejects.toBeInstanceOf(
        PaymentRequiredException,
      );
    });

    it("(d) propagates an unrelated error untouched (no over-broad catch)", async () => {
      const unrelated = new InternalServerErrorException("Usage count query failed");
      const assertWithinLimit = jest.fn().mockRejectedValue(unrelated);
      const tx = mockTxBuilder(null, null);
      (runInTenantTransaction as jest.Mock).mockImplementation(
        async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      );
      const svc = new CareersService(makeDb(), cache as never, { assertWithinLimit } as never);

      await expect(svc.apply(makeInput())).rejects.toBe(unrelated);
    });
  });
});
