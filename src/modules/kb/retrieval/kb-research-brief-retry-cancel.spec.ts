import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbResearchBriefService } from "./kb-research-brief.service";
import type { KbCitationVisibilityService } from "./kb-citation-visibility.service";
import type { AiJobsService } from "../../ai/jobs/ai-jobs.service";

const citationVisibility = {
  partitionVisible: jest.fn().mockResolvedValue({ visible: () => true }),
} as unknown as KbCitationVisibilityService;

const user = {
  orgId: "org-1",
  userId: "user-1",
  principal: humanSessionPrincipal(1, false),
} as never;

function makeBriefDb(brief: Record<string, unknown> | null) {
  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue(brief ? [brief] : []),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  } as unknown as Db;
}

function makeAiJobs(jobId = 42) {
  return {
    enqueue: jest.fn().mockResolvedValue({ jobId }),
    cancel: jest.fn().mockResolvedValue(undefined),
  } as unknown as AiJobsService;
}

describe("KbResearchBriefService.retryBrief", () => {
  it("re-queues a failed brief and returns the new jobId", async () => {
    const db = makeBriefDb({ id: 1, status: "failed", topic: "comp policy", spaceId: null, jobId: 5 });
    const aiJobs = makeAiJobs(99);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    const result = await svc.retryBrief(user, 1);

    expect(aiJobs.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: "kb.research-brief" }));
    expect(result).toEqual({ briefId: 1, jobId: 99 });
  });

  it("rejects retry of a brief that is not in failed status", async () => {
    const db = makeBriefDb({ id: 1, status: "queued", topic: "comp policy", spaceId: null, jobId: 5 });
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await expect(svc.retryBrief(user, 1)).rejects.toThrow("Only failed briefs can be retried");
    expect(aiJobs.enqueue).not.toHaveBeenCalled();
  });

  it("returns 404 when the brief does not exist for this user", async () => {
    const db = makeBriefDb(null);
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await expect(svc.retryBrief(user, 999)).rejects.toThrow("not found");
  });
});

describe("KbResearchBriefService.cancelBrief", () => {
  it("cancels the underlying job and marks the brief as failed", async () => {
    const db = makeBriefDb({ id: 1, status: "queued", topic: "comp policy", spaceId: null, jobId: 7 });
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await svc.cancelBrief(user, 1);

    expect(aiJobs.cancel).toHaveBeenCalledWith("org-1", 7);
    const updateMock = (db.update as jest.Mock).mock.results[0];
    const setCall = updateMock.value.set as jest.Mock;
    expect(setCall).toHaveBeenCalledWith(expect.objectContaining({ status: "failed", errorMessage: "Cancelled" }));
  });

  it("BITE: a queued brief is reachable after cancellation does not leave it in queued state", async () => {
    const db = makeBriefDb({ id: 1, status: "queued", topic: "comp policy", spaceId: null, jobId: 7 });
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await svc.cancelBrief(user, 1);

    const updateMock = (db.update as jest.Mock).mock.results[0];
    const setCall = updateMock.value.set as jest.Mock;
    expect(setCall).toHaveBeenCalledWith(expect.objectContaining({ status: "failed" }));
  });

  it("rejects cancellation of a brief that is not queued", async () => {
    const db = makeBriefDb({ id: 1, status: "running", topic: "comp policy", spaceId: null, jobId: 7 });
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await expect(svc.cancelBrief(user, 1)).rejects.toThrow("Only queued briefs can be cancelled");
    expect(aiJobs.cancel).not.toHaveBeenCalled();
  });

  it("returns 404 when the brief does not exist for this user", async () => {
    const db = makeBriefDb(null);
    const aiJobs = makeAiJobs();
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await expect(svc.cancelBrief(user, 999)).rejects.toThrow("not found");
  });
});
