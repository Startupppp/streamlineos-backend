import { BadRequestException } from "@nestjs/common";
import { getTableName } from "drizzle-orm";
import * as placementModule from "../../../common/org/sync-org-unit-placement";
import { RecruitmentCandidatesService } from "./recruitment-candidates.service";
import { RecruitmentSourcingService } from "./recruitment-sourcing.service";
import {
  advanceStageForScorecard,
  bonusAmountMinor,
  roundForInterview,
  roundLabelForStage,
  scorePercent,
} from "./ats-remaining";
import { RecruitmentHandoffService } from "./recruitment-handoff.service";

describe("scorecard auto-advance", () => {
  const round = {
    name: "Technical",
    roundType: "TECHNICAL",
    mode: "VIDEO",
    autoAdvanceThreshold: 70,
  };

  it("turns a 0–10 average into a 0–100 percent", () => {
    expect(scorePercent({ a: 8, b: 6 })).toBe(70);
    expect(scorePercent({})).toBeNull();
  });

  it("advances one legal stage when the hire recommendation clears the threshold", () => {
    expect(
      advanceStageForScorecard({
        stage: "INTERVIEW",
        recommendation: "HIRE",
        ratings: { depth: 8, communication: 7 },
        threshold: 70,
      }),
    ).toBe("OFFER");
    expect(
      advanceStageForScorecard({
        stage: "SCREENING",
        recommendation: "STRONG_HIRE",
        ratings: { fit: 9 },
        threshold: 80,
      }),
    ).toBe("INTERVIEW");
  });

  it("does not hire, reject, or move on a miss", () => {
    expect(
      advanceStageForScorecard({
        stage: "OFFER",
        recommendation: "HIRE",
        ratings: { depth: 10 },
        threshold: 50,
      }),
    ).toBeNull();
    expect(
      advanceStageForScorecard({
        stage: "INTERVIEW",
        recommendation: "MAYBE",
        ratings: { depth: 10 },
        threshold: 50,
      }),
    ).toBeNull();
    expect(
      advanceStageForScorecard({
        stage: "INTERVIEW",
        recommendation: "HIRE",
        ratings: { depth: 5 },
        threshold: 70,
      }),
    ).toBeNull();
    expect(
      advanceStageForScorecard({
        stage: "INTERVIEW",
        recommendation: "HIRE",
        ratings: { depth: 10 },
        threshold: null,
      }),
    ).toBeNull();
  });

  it("picks the one gated round that matches the interview, and refuses a tie", () => {
    expect(roundForInterview([round], "TECHNICAL")).toEqual(round);
    expect(
      roundForInterview(
        [
          round,
          { ...round, name: "Second", autoAdvanceThreshold: 80 },
        ],
        "TECHNICAL",
      ),
    ).toBeNull();
    expect(roundForInterview([round], "ASSESSMENT")).toEqual(round);
  });
});

describe("pipeline round labels", () => {
  const screening = { name: "Recruiter screen", roundType: "HR_SCREENING" };
  const technical = { name: "Technical", roundType: "TECHNICAL" };

  it("labels screening and interview from the open jobs when they agree", () => {
    const jobs = [{ rounds: [screening, technical] }, { rounds: [screening, technical] }];
    expect(roundLabelForStage("SCREENING", jobs)).toBe("Recruiter screen");
    expect(roundLabelForStage("INTERVIEW", jobs)).toBe("Technical");
    expect(roundLabelForStage("OFFER", jobs)).toBeNull();
  });

  it("does not rename a column when jobs disagree", () => {
    expect(
      roundLabelForStage("INTERVIEW", [
        { rounds: [technical] },
        { rounds: [{ name: "Manager", roundType: "MANAGER" }] },
      ]),
    ).toBe("Rounds differ by job");
  });
});

describe("duplicate merge", () => {
  it("moves applications, messages, documents, referrals, checks and interviews onto the keeper", async () => {
    const names: string[] = [];
    const db = {
      query: {
        candidates: {
          findFirst: jest
            .fn()
            .mockResolvedValueOnce({ id: 9, duplicateOfId: null })
            .mockResolvedValueOnce({ id: 3, duplicateOfId: null }),
        },
      },
      transaction: async (fn: (tx: { update: (table: object) => unknown }) => Promise<void>) =>
        fn({
          update: (table: object) => ({
            set: () => ({
              where: async () => {
                names.push(getTableName(table as never));
              },
            }),
          }),
        }),
    };
    const cache = { invalidateNamespace: jest.fn() };
    const service = new RecruitmentCandidatesService(
      db as never,
      cache as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(service.linkDuplicate("org-1", 9, 3)).resolves.toEqual({ success: true });
    expect(names).toEqual(
      expect.arrayContaining([
        "candidate_applications",
        "candidate_messages",
        "candidate_documents_vault",
        "candidate_referrals",
        "candidate_reference_checks",
        "interviews",
        "candidate_offers",
        "candidates",
      ]),
    );
  });
});

describe("referral bonus payable", () => {
  it("writes referral.bonus_due in minor units and does not write it twice", async () => {
    const inserts: Array<Record<string, unknown>> = [];
    const referral = {
      id: 4,
      candidateId: 8,
      referredBy: "user-1",
      bonusAmount: "1500.00",
      bonusPaidAt: null as Date | null,
    };
    const tx = {
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ ...referral, status: "BONUS_PAID", bonusPaidAt: new Date() }],
          }),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => [{ currency: "INR" }] }),
        }),
      }),
      execute: async () => [{ next: "1" }],
      insert: () => ({
        values: async (values: Record<string, unknown>) => {
          inserts.push(values);
        },
      }),
    };
    const db = {
      query: {
        candidateReferrals: { findFirst: jest.fn().mockResolvedValue(referral) },
        candidates: { findFirst: async () => ({ firstName: "Ada", lastName: "Lovelace" }) },
      },
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
    };
    const notifications = { create: jest.fn().mockResolvedValue(undefined) };
    const access = { membersWithPermission: jest.fn().mockResolvedValue([{ userId: "payroll-1" }]) };
    const service = new RecruitmentSourcingService(
      db as never,
      {} as never,
      {} as never,
      notifications as never,
      access as never,
    );

    await service.updateReferralStatus("org-1", 4, { status: "BONUS_PAID" });
    await new Promise((resolve) => setImmediate(resolve));

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      eventType: "referral.bonus_due",
      payload: { referralId: 4, amountMinor: 150000, currency: "INR", referrerUserId: "user-1" },
    });
    expect(notifications.create).toHaveBeenCalled();

    referral.bonusPaidAt = new Date();
    await service.updateReferralStatus("org-1", 4, { status: "BONUS_PAID" });
    expect(inserts).toHaveLength(1);
  });
});

describe("referral bonus minor units", () => {
  it("converts major units to integer minor units", () => {
    expect(bonusAmountMinor("5000.50")).toBe(500050);
    expect(bonusAmountMinor(" 12 ")).toBe(1200);
    expect(bonusAmountMinor(null)).toBeNull();
    expect(bonusAmountMinor("nope")).toBeNull();
  });
});

describe("hire packet on offer acceptance", () => {
  const placement = jest.spyOn(placementModule, "syncOrgUnitPlacement");

  beforeEach(() => {
    placement.mockReset();
    placement.mockResolvedValue(undefined);
  });

  afterAll(() => {
    placement.mockRestore();
  });

  function dbFor(matchedUser: { id: string } | null) {
    const inserted: Array<Record<string, unknown>> = [];
    let joins = 0;
    const tx = {
      select: () => ({
        from: () => ({
          innerJoin: () => ({
            where: () => ({
              limit: async () => {
                joins += 1;
                if (joins === 1) return matchedUser ? [matchedUser] : [];
                return [];
              },
            }),
          }),
          where: () => ({ limit: async () => [{ currency: "INR" }] }),
        }),
      }),
      query: {
        organizationPeople: { findFirst: async () => null },
        hrPeople: { findFirst: async () => null },
        hrEmployments: { findFirst: async () => null },
      },
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          const rows = values.employeeNumber ? [{ id: 50 }] : [{ organizationPersonId: "op-1", id: 7 }];
          const pending = Promise.resolve(rows);
          return {
            returning: () => pending,
            onConflictDoUpdate: () => pending,
          };
        },
      }),
    };
    const db = {
      query: {
        candidates: {
          findFirst: async () => ({
            firstName: "Ada",
            lastName: "Lovelace",
            email: "ada@example.com",
            phone: null,
            resumeUrl: "https://files.example/resume.pdf",
          }),
        },
        candidateOffers: {
          findFirst: async () => ({
            offeredSalary: null,
            offeredDesignation: "Engineer",
            joiningDate: "2026-08-01",
          }),
        },
        candidateApplications: {
          findFirst: async () => ({ jobPosting: { orgDepartmentId: "dept-1" } }),
        },
      },
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    };
    return { db, inserted };
  }

  it("copies department, designation and the résumé onto the employment when nobody has a login yet", async () => {
    const { db, inserted } = dbFor(null);
    const service = new RecruitmentHandoffService(db as never, { log: jest.fn() } as never);
    await service.handleOfferAccepted("org-1", 99, 12);

    const employment = inserted.find((row) => row.employeeNumber === "CAND-99");
    expect(employment).toMatchObject({
      departmentId: "dept-1",
      designation: "Engineer",
      customFieldValues: { hireResumeUrl: "https://files.example/resume.pdf" },
    });
    expect(placement).not.toHaveBeenCalled();
  });

  it("places the matched member in the job's department and files the résumé on them", async () => {
    const { db, inserted } = dbFor({ id: "user-1" });
    const service = new RecruitmentHandoffService(db as never, { log: jest.fn() } as never);
    await service.handleOfferAccepted("org-1", 99, 12);

    expect(placement).toHaveBeenCalledWith(expect.anything(), "org-1", "user-1", { DEPARTMENT: "dept-1" });
    expect(inserted.some((row) => row.type === "RESUME" && row.userId === "user-1")).toBe(true);
  });

  it("still creates the employment when the department cannot be placed", async () => {
    placement.mockRejectedValueOnce(new BadRequestException("Invalid department selection."));
    const { db, inserted } = dbFor({ id: "user-1" });
    const service = new RecruitmentHandoffService(db as never, { log: jest.fn() } as never);
    await expect(service.handleOfferAccepted("org-1", 99, 12)).resolves.toBeUndefined();
    expect(inserted.some((row) => row.departmentId === "dept-1")).toBe(true);
  });
});
