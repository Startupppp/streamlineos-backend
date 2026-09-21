import { ForbiddenException } from "@nestjs/common";
import { ExitService } from "./exit.service";
import { resignationDetailSchema, resignationListSchema } from "./dto/lifecycle-response.schemas";

const ORG = "org-exit-contract";

const row = {
  id: 9,
  orgId: ORG,
  userId: "leaver",
  reason: "A very private reason",
  reasonCategory: "career",
  lastWorkingDate: "2026-10-31",
  noticePeriodDays: 30,
  status: "FINAL_APPROVED",
  resignationLetterUrl: `${ORG}/resignations/letter.pdf`,
  approvedBy: "hr",
  approvedAt: new Date("2026-09-20T00:00:00Z"),
  hrReviewedBy: "hr",
  hrReviewedAt: new Date("2026-09-19T00:00:00Z"),
  hrRemarks: "HR only remark",
  finalReviewedBy: "hr",
  finalReviewedAt: new Date("2026-09-20T00:00:00Z"),
  finalRemarks: "Final remark",
  willingForExitInterview: true,
  companyFeedback: "Candid feedback",
  exitInterviewNotes: null,
  exitInterviewDate: null,
  exitInterviewConductedBy: null,
  feedback: null,
  userMembershipId: 70,
  rowVersion: 2,
  createdAt: new Date("2026-09-18T00:00:00Z"),
  updatedAt: new Date("2026-09-20T00:00:00Z"),
  user: { id: "leaver", name: "Lee Aver", email: "lee@x.test", image: null },
  hrReviewer: { id: "hr", name: "HR Admin" },
  finalReviewer: { id: "hr", name: "HR Admin" },
};

const emptyChecklist = { items: [], summary: { total: 0, open: 0, done: 0, waived: 0, overdue: 0 } };

function buildService(routedIds: number[] = []) {
  const db = {
    query: {
      resignations: {
        findMany: jest.fn().mockResolvedValue([row]),
        findFirst: jest.fn().mockResolvedValue(row),
      },
    },
  };
  const employment = {
    getFactsBatch: jest.fn().mockResolvedValue(new Map([["leaver", { designation: "Engineer", joiningDate: "2024-01-01" }]])),
    getFacts: jest.fn().mockResolvedValue({ designation: "Engineer", joiningDate: "2024-01-01" }),
  };
  const checklist = {
    resignationIdsRoutedTo: jest.fn().mockResolvedValue(routedIds),
    listForResignation: jest.fn().mockResolvedValue(emptyChecklist),
  };
  return { service: new ExitService(db as never, employment as never, checklist as never), checklist };
}

describe("the exit read contracts describe what the service actually returns", () => {
  it("GET /hr/exit rows carry hasResignationLetter and an enriched user, and never the letter's storage key", async () => {
    const { service } = buildService();

    const page = await service.list(ORG, "hr", true, { limit: 20 });

    expect(resignationListSchema.safeParse(page).success).toBe(true);
    expect(page.data[0]).not.toHaveProperty("resignationLetterUrl");
    expect(page.data[0]).toMatchObject({ hasResignationLetter: true, user: { designation: "Engineer", joiningDate: "2024-01-01" } });
  });

  it("GET /hr/exit/:resignationId carries the timeline and the single offboarding checklist", async () => {
    const { service, checklist } = buildService();

    const detail = await service.getDetail(ORG, "hr", true, 9, 1);

    expect(resignationDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.checklist).toEqual(emptyChecklist);
    expect(detail.progress.map((step) => step.label)).toEqual(["Submitted", "HR Review", "Final Review", "Exit Process", "Completed"]);
    expect(checklist.listForResignation).toHaveBeenCalledWith(ORG, 9, { userId: "hr", membershipId: 1, isAdmin: true });
  });

  it("a manager who owns a checklist item can open the exit, sees the checklist, and does not see the leaver's confidential fields", async () => {
    const { service } = buildService([9]);

    const detail = await service.getDetail(ORG, "manager", false, 9, 44);

    expect(resignationDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({ reason: null, companyFeedback: null, hrRemarks: null, finalRemarks: null, feedback: null });
    expect(detail.progress.find((step) => step.label === "HR Review")?.remarks).toBeNull();
    expect(detail.user?.name).toBe("Lee Aver");
  });

  it("a member with no item on the exit and no ownership of it is refused inside the tenant", async () => {
    const { service } = buildService([]);

    await expect(service.getDetail(ORG, "colleague", false, 9, 45)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("the leaver still sees their own reason and remarks", async () => {
    const { service } = buildService([]);

    const detail = await service.getDetail(ORG, "leaver", false, 9, 70);

    expect(detail.reason).toBe("A very private reason");
    expect(detail.hrRemarks).toBe("HR only remark");
  });
});
