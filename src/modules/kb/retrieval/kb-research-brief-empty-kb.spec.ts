import { HttpException, HttpStatus } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { KbResearchBriefService } from "./kb-research-brief.service";

const aiJobs = {
  enqueue: jest.fn().mockResolvedValue({ jobId: 1 }),
} as never;

const citationVisibility = {
  partitionVisible: jest.fn().mockResolvedValue({ visible: () => true }),
} as never;

function makeUser(orgId = "org-1") {
  return {
    orgId,
    userId: "user-1",
    isOrgOwner: false,
    principal: humanSessionPrincipal(1, false),
  } as never;
}

function makeDb(hasIndexedContent: boolean): Db {
  return {
    execute: jest.fn().mockResolvedValue(hasIndexedContent ? [{ one: 1 }] : []),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ count: 0 }]),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 99 }]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([]),
      }),
    }),
  } as unknown as Db;
}

describe("KbResearchBriefService.enqueue — no-indexed-content precondition (BE-94)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("rejects with 409 when the org has no indexed KB content at enqueue time", async () => {
    const svc = new KbResearchBriefService(makeDb(false), aiJobs, citationVisibility);

    const error = await svc
      .enqueue(makeUser(), { topic: "Security best practices" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(HttpStatus.CONFLICT);
  });

  it("the 409 body carries KB_NO_INDEXED_CONTENT so the frontend can surface an actionable message", async () => {
    const svc = new KbResearchBriefService(makeDb(false), aiJobs, citationVisibility);

    const error = await svc
      .enqueue(makeUser(), { topic: "Security best practices" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse();
    expect(body).toEqual(
      expect.objectContaining({ code: "KB_NO_INDEXED_CONTENT" }),
    );
  });

  it("the rejection message tells the user to publish and index pages before generating a brief", async () => {
    const svc = new KbResearchBriefService(makeDb(false), aiJobs, citationVisibility);

    const error = await svc
      .enqueue(makeUser(), { topic: "Security best practices" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HttpException);
    const body = (error as HttpException).getResponse() as Record<string, unknown>;
    expect(String(body["message"])).toMatch(/publish/i);
  });

  it("does not insert a brief row when the content precondition is not met", async () => {
    const db = makeDb(false);
    const svc = new KbResearchBriefService(db, aiJobs, citationVisibility);

    await svc.enqueue(makeUser(), { topic: "Security best practices" }).catch(() => undefined);

    expect((db.insert as jest.Mock)).not.toHaveBeenCalled();
  });

  it("BITE: proceeds to enqueue and returns briefId when the org has indexed content", async () => {
    const svc = new KbResearchBriefService(makeDb(true), aiJobs, citationVisibility);

    const result = await svc.enqueue(makeUser(), { topic: "Security best practices" });

    expect(result).toEqual(expect.objectContaining({ briefId: expect.any(Number), jobId: expect.any(Number) }));
  });
});
