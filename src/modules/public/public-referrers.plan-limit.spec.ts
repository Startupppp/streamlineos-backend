import { BadRequestException, InternalServerErrorException } from "@nestjs/common";
import { PaymentRequiredException } from "../../common/http/api-exceptions";
import { PublicReferrersService } from "./public-referrers.service";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";
const REFERRER_ID = 3;
const REFERRER_TOKEN = "token-abc";

const FORBIDDEN_STRINGS = ["quota", "QUOTA_EXCEEDED", "plan", "limit", "402"];

jest.mock("../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(),
}));
jest.mock("../../common/tenant/with-public-token", () => ({
  withPublicToken: jest.fn(),
}));

import { runInTenantTransaction } from "../../common/tenant/run-in-tenant-transaction";
import { withPublicToken } from "../../common/tenant/with-public-token";

const referrer = { id: REFERRER_ID, orgId: ORG, status: "ACTIVE" };

function makeTx(existingCandidate: unknown) {
  return {
    query: {
      jobPostings: { findFirst: jest.fn().mockResolvedValue(null) },
      candidates: { findFirst: jest.fn().mockResolvedValue(existingCandidate) },
      externalReferrals: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 55, orgId: ORG, referrerId: REFERRER_ID, candidateId: 42 }]),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
  };
}

function makeDb(): Db {
  return {} as unknown as Db;
}

function makeInput() {
  return {
    firstName: "Jane",
    lastName: "Doe",
    email: "jane@example.com",
    phone: undefined,
    jobPostingId: undefined,
  } as Parameters<PublicReferrersService["submitExternalReferral"]>[1];
}

describe("PublicReferrersService.submitExternalReferral — plan limit enforcement", () => {
  beforeEach(() => {
    (withPublicToken as jest.Mock).mockResolvedValue(referrer);
  });
  afterEach(() => jest.clearAllMocks());

  it("allows submission when quota is not exceeded for a new candidate", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx(null);
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicReferrersService(makeDb(), { assertWithinLimit } as never);

    await svc.submitExternalReferral(REFERRER_TOKEN, makeInput());

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates", 1, tx);
  });

  it("skips assertion when candidate already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const tx = makeTx({ id: 77 });
    (runInTenantTransaction as jest.Mock).mockImplementation(
      async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    );
    const svc = new PublicReferrersService(makeDb(), { assertWithinLimit } as never);

    await svc.submitExternalReferral(REFERRER_TOKEN, makeInput());

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
      const svc = new PublicReferrersService(makeDb(), { assertWithinLimit } as never);
      return { svc, tx, assertWithinLimit };
    }

    it("(a) still prevents the insert when quota is exhausted", async () => {
      const { svc, tx } = makeExceededSvc();

      await expect(svc.submitExternalReferral(REFERRER_TOKEN, makeInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );

      expect(tx.insert).not.toHaveBeenCalled();
    });

    it("(b) surfaces a neutral 400 with no billing vocabulary", async () => {
      const { svc } = makeExceededSvc();

      let caught: unknown;
      try {
        await svc.submitExternalReferral(REFERRER_TOKEN, makeInput());
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
      const svc = new PublicReferrersService(makeDb(), { assertWithinLimit } as never);

      await expect(svc.submitExternalReferral(REFERRER_TOKEN, makeInput())).rejects.toBe(unrelated);
    });
  });
});
