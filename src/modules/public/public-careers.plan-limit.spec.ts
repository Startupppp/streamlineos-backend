import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { PublicCareersService } from "./public-careers.service";
import type { Db } from "../../db/drizzle.module";

const ORG_SLUG = "acme";
const ORG = "org-1";
const JOB_ID = 9;

const FORBIDDEN_STRINGS = ["quota", "QUOTA_EXCEEDED", "plan", "limit", "402"];

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));

import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";

function makeDb(): Db {
  return {
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({ id: ORG, name: "Acme" }),
      },
      jobPostings: {
        findFirst: jest.fn().mockResolvedValue({ id: JOB_ID, title: "Engineer" }),
      },
    },
  } as unknown as Db;
}

function makeTx(existingByEmail: unknown) {
  const selectLimit = jest.fn().mockResolvedValue(existingByEmail ? [existingByEmail] : []);
  const selectWhere = jest.fn().mockReturnValue({ limit: selectLimit });
  const selectFrom = jest.fn().mockReturnValue({ where: selectWhere });
  const select = jest.fn().mockReturnValue({ from: selectFrom });

  const racedLimit = jest.fn().mockResolvedValue([]);
  const racedWhere = jest.fn().mockReturnValue({ limit: racedLimit });
  const racedFrom = jest.fn().mockReturnValue({ where: racedWhere });

  return {
    select: jest.fn()
      .mockReturnValueOnce({ from: selectFrom })
      .mockReturnValue({ from: racedFrom }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ id: 42 }]),
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    _selectLimit: selectLimit,
    _select: select,
  };
}

function makeInput() {
  return {
    name: "Jane Doe",
    email: "jane@example.com",
    phone: undefined,
    linkedinUrl: undefined,
    coverLetter: undefined,
    resumeUrl: undefined,
  } as Parameters<PublicCareersService["applyToOrgJob"]>[2];
}

describe("PublicCareersService.applyToOrgJob — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows application and asserts quota for a new candidate", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx(null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

    const result = await svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput());

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates", 1, tx);
    expect(result).toHaveProperty("trackingToken");
  });

  it("skips assertion when the candidate email already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx({ id: 77 });
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

    await svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput());

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
      const tx = makeTx(null);
      (runInTenantTransaction as jest.Mock).mockImplementation(
        async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      );
      const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);
      return { svc, tx, assertWithinLimit };
    }

    it("(a) still prevents the insert when quota is exhausted", async () => {
      const { svc, tx } = makeExceededSvc();

      await expect(svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(tx.insert).not.toHaveBeenCalled();
    });

    it("(b) surfaces a neutral 400 with no billing vocabulary", async () => {
      const { svc } = makeExceededSvc();

      let caught: unknown;
      try {
        await svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput());
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
      const tx = makeTx(null);
      (runInTenantTransaction as jest.Mock).mockImplementation(
        async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
      );
      const svc = new PublicCareersService(makeDb(), { assertWithinLimit } as never);

      await expect(svc.applyToOrgJob(ORG_SLUG, JOB_ID, makeInput())).rejects.toBe(unrelated);
    });
  });
});
