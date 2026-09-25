import { HttpException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbResearchBriefService, KB_RESEARCH_BRIEF_CONCURRENT_LIMIT } from "./kb-research-brief.service";

const citationVisibility = {
  partitionVisible: jest.fn().mockResolvedValue({ visible: () => true }),
} as never;

const aiJobs = {
  enqueue: jest.fn().mockResolvedValue({ jobId: 1 }),
} as never;

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function makeDb(activeCount: number) {
  const insertMock = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ id: 99 }]),
    }),
  });
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ count: activeCount }]),
      }),
    }),
    insert: insertMock,
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;
  return { db, insertMock };
}

describe("KbResearchBriefService — research job quota", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("allows enqueue when the org has fewer active jobs than the limit", async () => {
    const { db } = makeDb(KB_RESEARCH_BRIEF_CONCURRENT_LIMIT - 1);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await expect(svc.enqueue(makeUser(), { topic: "Onboarding guide" })).resolves.toEqual(
      expect.objectContaining({ briefId: expect.any(Number) }),
    );
  });

  it("throws 429 when the org is at the research job concurrent limit", async () => {
    const { db } = makeDb(KB_RESEARCH_BRIEF_CONCURRENT_LIMIT);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    const error = await svc.enqueue(makeUser(), { topic: "Security audit" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(429);
  });

  it("the 429 body carries KB_RESEARCH_JOB_QUOTA_EXCEEDED so callers can distinguish it from request-rate-limit 429s", async () => {
    const { db } = makeDb(KB_RESEARCH_BRIEF_CONCURRENT_LIMIT);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    const error = await svc.enqueue(makeUser(), { topic: "Security audit" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse();
    expect(body).toEqual(
      expect.objectContaining({ code: "KB_RESEARCH_JOB_QUOTA_EXCEEDED" }),
    );
  });

  it("does not insert a brief row when the quota check denies", async () => {
    const { db, insertMock } = makeDb(KB_RESEARCH_BRIEF_CONCURRENT_LIMIT);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await svc.enqueue(makeUser(), { topic: "Security audit" }).catch(() => undefined);

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("counts only queued and running briefs so completed jobs do not erode the quota", async () => {
    const { db } = makeDb(0);
    const selectMock = db.select as jest.Mock;

    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);
    await svc.enqueue(makeUser(), { topic: "New topic" });

    expect(selectMock).toHaveBeenCalled();
    const fromMock = selectMock.mock.results[0]?.value?.from as jest.Mock | undefined;
    if (fromMock === undefined) return;
    const whereMock = fromMock.mock.results[0]?.value?.where as jest.Mock | undefined;
    if (whereMock === undefined) return;
    const whereArg = whereMock.mock.calls[0]?.[0];
    const vals = sqlValues(whereArg);
    expect(vals).toContain("queued");
    expect(vals).toContain("running");
  });
});

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap((i) => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v as object)) return [];
  seen.add(v as object);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  const fromChunks = r.queryChunks ? sqlValues(r.queryChunks, seen) : [];
  const fromValue = Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [];
  return [...fromChunks, ...fromValue];
}
