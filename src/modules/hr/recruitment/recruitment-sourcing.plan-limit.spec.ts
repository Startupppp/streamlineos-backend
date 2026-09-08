import { PaymentRequiredException } from "../../../common/http/api-exceptions";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-1";
const USER = "user-1";
const MEMBERSHIP_ID = 7;

function makeReferralInsert() {
  return {
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 99, orgId: ORG, candidateId: 42 }]),
    }),
  };
}

function makeCandidateInsert() {
  return {
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 42 }]),
    }),
  };
}

function makeDb(existingCandidate: { id: number } | null = null): Db {
  return {
    query: {
      candidates: { findFirst: jest.fn().mockResolvedValue(existingCandidate) },
      jobPostings: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest
      .fn()
      .mockReturnValueOnce(makeCandidateInsert())
      .mockReturnValue(makeReferralInsert()),
  } as unknown as Db;
}

function makeDbExisting(): Db {
  return {
    query: {
      candidates: { findFirst: jest.fn().mockResolvedValue({ id: 10 }) },
      jobPostings: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    insert: jest.fn().mockReturnValue(makeReferralInsert()),
  } as unknown as Db;
}

function makeInput() {
  return {
    firstName: "Test",
    lastName: "User",
    email: "test@x.com",
    phone: undefined,
    jobPostingId: undefined,
    relationship: "COLLEAGUE" as const,
    notes: undefined,
  };
}

describe("RecruitmentSourcingService.createReferral — plan limit enforcement", () => {
  afterEach(() => jest.clearAllMocks());

  it("allows creation of a new candidate when quota is not exceeded", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const svc = new RecruitmentSourcingService(
      makeDb(null),
      {} as never,
      { assertWithinLimit } as never,
    );

    await svc.createReferral(ORG, USER, makeInput(), MEMBERSHIP_ID);

    expect(assertWithinLimit).toHaveBeenCalledWith(ORG, "hrCandidates");
  });

  it("refuses when quota is exceeded for a new candidate", async () => {
    const assertWithinLimit = jest
      .fn()
      .mockRejectedValue(new PaymentRequiredException({ code: "QUOTA_EXCEEDED", message: "limit" }));
    const svc = new RecruitmentSourcingService(
      makeDb(null),
      {} as never,
      { assertWithinLimit } as never,
    );

    await expect(svc.createReferral(ORG, USER, makeInput(), MEMBERSHIP_ID)).rejects.toBeInstanceOf(
      PaymentRequiredException,
    );
  });

  it("skips assertion when candidate already exists in the org", async () => {
    const assertWithinLimit = jest.fn().mockResolvedValue(undefined);
    const svc = new RecruitmentSourcingService(
      makeDbExisting(),
      {} as never,
      { assertWithinLimit } as never,
    );

    await svc.createReferral(ORG, USER, makeInput(), MEMBERSHIP_ID);

    expect(assertWithinLimit).not.toHaveBeenCalled();
  });
});
