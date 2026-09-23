import { ConflictException, UnprocessableEntityException } from "@nestjs/common";
import { RecruitmentRequisitionsService } from "./recruitment-requisitions.service";
import { REQUISITION_TRANSITIONS } from "./dto/requisitions.schemas";

const ORG = "org-1";
const ID = 4;

function build(status: string, options: { rowsAffected?: number } = {}) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => Promise.resolve([{ id: ID, orgId: ORG, status }])),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => ({
        where: jest.fn(() => ({
          returning: jest.fn(() => {
            updates.push(values);
            return Promise.resolve(
              (options.rowsAffected ?? 1) === 0 ? [] : [{ id: ID, ...values }],
            );
          }),
        })),
      })),
    })),
  };
  return { service: new RecruitmentRequisitionsService(db as never), updates, db };
}

/**
 * Submit, approve and reject each wrote the status from ANY prior value. These
 * are the moves that were silently legal.
 */
describe("requisition transitions — the illegal ones", () => {
  it.each([
    ["APPROVED", "submit"],
    ["REJECTED", "submit"],
    ["FILLED", "submit"],
    ["PENDING_APPROVAL", "submit"],
    ["DRAFT", "approve"],
    ["REJECTED", "approve"],
    ["APPROVED", "approve"],
    ["FILLED", "approve"],
    ["DRAFT", "reject"],
    ["APPROVED", "reject"],
    ["REJECTED", "reject"],
  ] as const)("refuses %s → %s", async (from, action) => {
    const { service, updates } = build(from);
    const call =
      action === "submit"
        ? service.submit(ORG, ID)
        : action === "approve"
          ? service.approve(ORG, ID, "approver")
          : service.reject(ORG, ID, "approver", "not now");
    await expect(call).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(updates).toHaveLength(0);
  });
});

describe("requisition transitions — the legal ones", () => {
  it("submits a DRAFT", async () => {
    const { service, updates } = build("DRAFT");
    await service.submit(ORG, ID);
    expect(updates[0]).toMatchObject({ status: "PENDING_APPROVAL" });
  });

  it("approves a PENDING_APPROVAL and records who approved it", async () => {
    const { service, updates } = build("PENDING_APPROVAL");
    await service.approve(ORG, ID, "approver-9");
    expect(updates[0]).toMatchObject({ status: "APPROVED", approverId: "approver-9" });
    expect(updates[0]?.approvedAt).toBeInstanceOf(Date);
  });

  it("rejects a PENDING_APPROVAL with the reason", async () => {
    const { service, updates } = build("PENDING_APPROVAL");
    await service.reject(ORG, ID, "approver-9", "budget pulled");
    expect(updates[0]).toMatchObject({ status: "REJECTED", rejectionReason: "budget pulled" });
  });
});

describe("requisition edits", () => {
  it.each(["APPROVED", "REJECTED", "FILLED"])(
    "refuses to change the terms of a %s requisition",
    async (status) => {
      const { service, updates } = build(status);
      await expect(service.update(ORG, ID, { title: "Rewritten" })).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(updates).toHaveLength(0);
    },
  );

  it("allows an edit while it is still DRAFT", async () => {
    const { service, updates } = build("DRAFT");
    await service.update(ORG, ID, { title: "Senior Engineer" });
    expect(updates[0]).toMatchObject({ title: "Senior Engineer" });
  });
});

/**
 * Two approvers clicking at once both read PENDING_APPROVAL. The conditional
 * `WHERE status = <from>` is what makes the second one lose.
 */
describe("concurrent approval", () => {
  it("409s the approver whose conditional update matched no row", async () => {
    const { service } = build("PENDING_APPROVAL", { rowsAffected: 0 });
    await expect(service.approve(ORG, ID, "approver-b")).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("the status map itself", () => {
  it("has no state the service cannot write", () => {
    /**
     * `PUBLISHED` and `CLOSED` were selectable filters that no code path could
     * ever produce. Every key here is written by submit, approve, reject,
     * create, or the hire that fills the job.
     */
    expect(Object.keys(REQUISITION_TRANSITIONS).sort()).toEqual([
      "APPROVED",
      "DRAFT",
      "FILLED",
      "PENDING_APPROVAL",
      "REJECTED",
    ]);
  });

  it("has no transition pointing at a state that is not in the map", () => {
    for (const [from, tos] of Object.entries(REQUISITION_TRANSITIONS))
      for (const to of tos) expect(REQUISITION_TRANSITIONS).toHaveProperty(to, expect.anything());
    expect(REQUISITION_TRANSITIONS.FILLED).toEqual([]);
  });
});
