import type { Db } from "../../../db/drizzle.module";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import {
  candidateReferralWithRelationsSchema,
  externalReferralWithRelationsSchema,
} from "./dto/recruitment-sourcing-response.schemas";

const RELATIONS = {
  candidate: { id: 9, firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
  jobPosting: { id: 4, title: "Staff Engineer" },
};

const REFERRAL_ROW = {
  id: 1,
  orgId: "org-1",
  candidateId: 9,
  referredBy: "user-1",
  referredByMembershipId: 7,
  jobPostingId: 4,
  relationship: "Former colleague",
  notes: null,
  status: "SUBMITTED",
  bonusEligible: false,
  bonusAmount: null,
  bonusPaidAt: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
  ...RELATIONS,
  referrer: { id: "user-1", name: "Grace", email: "grace@example.com" },
};

const EXTERNAL_ROW = {
  id: 2,
  orgId: "org-1",
  referrerId: 3,
  candidateId: 9,
  jobPostingId: 4,
  status: "REWARD_PAID",
  rewardAmount: "500.00",
  rewardPaidAt: new Date("2026-02-01T00:00:00Z"),
  ipAddress: null,
  createdAt: new Date("2026-02-01T00:00:00Z"),
  updatedAt: new Date("2026-02-01T00:00:00Z"),
  ...RELATIONS,
  referrer: { id: 3, name: "Grace", email: "grace@example.com" },
};

function makeDb(hydrated: Record<string, unknown>) {
  const findFirst = jest.fn().mockResolvedValue(hydrated);
  const { candidate, referrer, jobPosting, ...bare } = hydrated;
  void candidate;
  void referrer;
  void jobPosting;
  const returning = jest.fn().mockResolvedValue([bare]);
  const db = {
    insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning }) }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ returning }) }),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([{ currency: "INR" }]) }),
      }),
    }),
    query: {
      candidateReferrals: { findFirst },
      candidates: { findFirst: jest.fn().mockResolvedValue({ id: 9 }) },
      jobPostings: { findFirst: jest.fn().mockResolvedValue({ orgId: "org-1" }) },
      externalReferrals: { findFirst },
    },
  };
  const withTx = { ...db, transaction: jest.fn().mockImplementation((fn: (tx: Db) => unknown) => fn(withTx as unknown as Db)) };
  return { db: withTx as unknown as Db, findFirst };
}

function service(db: Db) {
  return new RecruitmentSourcingService(db, {} as never, { assertWithinLimit: jest.fn() } as never);
}

describe("referral mutation responses carry their declared relations", () => {
  it("POST /hr/recruitment/referrals satisfies candidateReferralWithRelationsSchema", async () => {
    const { db } = makeDb(REFERRAL_ROW);
    const result = await service(db).createReferral(
      "org-1",
      "user-1",
      { firstName: "Ada", lastName: "Lovelace", email: "ada@example.com" },
      7,
    );
    expect(candidateReferralWithRelationsSchema.safeParse(result).success).toBe(true);
  });

  it("PATCH /hr/recruitment/referrals/:id satisfies candidateReferralWithRelationsSchema", async () => {
    const { db } = makeDb(REFERRAL_ROW);
    const result = await service(db).updateReferralStatus("org-1", 1, { status: "REVIEWING" });
    expect(candidateReferralWithRelationsSchema.safeParse(result).success).toBe(true);
  });

  it("PATCH /hr/recruitment/external-referrals/:id satisfies externalReferralWithRelationsSchema", async () => {
    const { db } = makeDb(EXTERNAL_ROW);
    const result = await service(db).updateExternalReferral("org-1", 2, { status: "REWARD_PAID" });
    expect(externalReferralWithRelationsSchema.safeParse(result).success).toBe(true);
  });
});
