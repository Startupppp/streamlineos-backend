import type { ModuleRef } from "@nestjs/core";
import { findConfirmableAction } from ".";
import { RecruitmentJobsService } from "../../../hr/recruitment/recruitment-jobs.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.module";

const mockActor: CurrentUserContext = {
  userId: "user-abc",
  orgId: "org-xyz",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 7, isOrgOwner: false },
};

function makeJobsModuleRef(jobs: Partial<RecruitmentJobsService>): ModuleRef {
  return {
    get: jest.fn().mockReturnValue(jobs),
  } as unknown as ModuleRef;
}

describe("self.applyToJobOpening — confirmable action executor", () => {
  const definition = findConfirmableAction("self.applyToJobOpening");

  it("is registered as a confirmable action so the tool proposal is redeemable", () => {
    expect(definition).toBeDefined();
  });

  it("requires self:job-openings permission, not a broader HR administrative permission", () => {
    expect(definition?.permission).toBe("self:job-openings");
  });

  it("dispatches to RecruitmentJobsService.internalApply rather than writing to the DB directly", async () => {
    const mockInternalApply = jest.fn().mockResolvedValue({ id: 99 });
    const moduleRef = makeJobsModuleRef({ internalApply: mockInternalApply });

    await definition?.execute(
      { jobId: 5, coverLetter: "I am interested", notes: null },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(mockInternalApply).toHaveBeenCalledTimes(1);
    expect(mockInternalApply).toHaveBeenCalledWith(
      "org-xyz",
      "user-abc",
      5,
      expect.objectContaining({ coverLetter: "I am interested" }),
    );
  });

  it("binds orgId and userId from the confirmed actor, so the payload cannot redirect the application to a different employee", async () => {
    const mockInternalApply = jest.fn().mockResolvedValue({ id: 100 });
    const moduleRef = makeJobsModuleRef({ internalApply: mockInternalApply });

    await definition?.execute(
      { jobId: 3, coverLetter: null, notes: null },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    const [calledOrgId, calledUserId] = mockInternalApply.mock.calls[0] as [string, string, ...unknown[]];
    expect(calledOrgId).toBe("org-xyz");
    expect(calledUserId).toBe("user-abc");
  });

  it("converts null optional fields to undefined so the InternalApplyInput schema accepts them", async () => {
    const mockInternalApply = jest.fn().mockResolvedValue({ id: 101 });
    const moduleRef = makeJobsModuleRef({ internalApply: mockInternalApply });

    await definition?.execute(
      { jobId: 7, coverLetter: null, notes: null },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    const callArg = mockInternalApply.mock.calls[0]?.[3] as Record<string, unknown>;
    expect(callArg["coverLetter"]).toBeUndefined();
    expect(callArg["notes"]).toBeUndefined();
  });

  it("includes applicationId in the result so the confirmation card can surface a reference", async () => {
    const mockInternalApply = jest.fn().mockResolvedValue({ id: 202 });
    const moduleRef = makeJobsModuleRef({ internalApply: mockInternalApply });

    const outcome = await definition?.execute(
      { jobId: 9, coverLetter: null, notes: null },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(outcome?.result["applicationId"]).toBe(202);
  });

  it("returns a summary that names the job opening, so the chat surface can confirm what was done", async () => {
    const mockInternalApply = jest.fn().mockResolvedValue({ id: 203 });
    const moduleRef = makeJobsModuleRef({ internalApply: mockInternalApply });

    const outcome = await definition?.execute(
      { jobId: 12, coverLetter: null, notes: null },
      { actor: mockActor, db: {} as Db, moduleRef, proposalId: 1 },
    );

    expect(outcome?.summary).toContain("12");
  });
});
