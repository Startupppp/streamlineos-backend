import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProjectsFeedbackService } from "../feedback/projects-feedback.service";
import type { Db } from "../../../../db/drizzle.module";
import { lifecycleAuditDouble } from "../../lifecycle/audit-double.spec-fixtures";

const ORG_ID = "org-1";

interface PostRow {
  id: number;
  orgId: string;
  duplicateOfId: number | null;
}

describe("ProjectsFeedbackService — mergeFeedback", () => {
  let svc: ProjectsFeedbackService;
  let findFirst: jest.Mock;
  let execute: jest.Mock;
  let updateSet: jest.Mock;
  let deleteWhere: jest.Mock;
  let canonical: PostRow;

  function makeTx() {
    updateSet = jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) });
    deleteWhere = jest.fn().mockResolvedValue(undefined);
    return {
      query: { feedbackPosts: { findFirst } },
      execute,
      update: jest.fn().mockReturnValue({ set: updateSet }),
      delete: jest.fn().mockReturnValue({ where: deleteWhere }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([canonical]) }),
        }),
      }),
    };
  }

  beforeEach(() => {
    canonical = { id: 10, orgId: ORG_ID, duplicateOfId: null };
    findFirst = jest.fn();
    execute = jest.fn().mockResolvedValue(undefined);
    const db = {
      transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx())),
    } as unknown as Db;
    svc = new ProjectsFeedbackService(db, lifecycleAuditDouble());
  });

  it("rejects merging a post into itself", async () => {
    await expect(svc.mergeFeedback(ORG_ID, 5, { targetPostId: 5 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("throws NotFound when either post is missing or belongs to another org", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, orgId: ORG_ID, duplicateOfId: null });
    findFirst.mockResolvedValueOnce(undefined);
    await expect(svc.mergeFeedback(ORG_ID, 5, { targetPostId: 10 })).rejects.toThrow(
      NotFoundException,
    );
  });

  it("rejects when the source has already been merged", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, orgId: ORG_ID, duplicateOfId: 99 });
    findFirst.mockResolvedValueOnce(canonical);
    await expect(svc.mergeFeedback(ORG_ID, 5, { targetPostId: 10 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects merging into a post that is itself a duplicate, so chains cannot form", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, orgId: ORG_ID, duplicateOfId: null });
    findFirst.mockResolvedValueOnce({ id: 10, orgId: ORG_ID, duplicateOfId: 20 });
    await expect(svc.mergeFeedback(ORG_ID, 5, { targetPostId: 10 })).rejects.toThrow(
      BadRequestException,
    );
  });

  it("moves votes, re-points existing duplicates and marks the source merged", async () => {
    findFirst.mockResolvedValueOnce({ id: 5, orgId: ORG_ID, duplicateOfId: null });
    findFirst.mockResolvedValueOnce(canonical);

    const result = await svc.mergeFeedback(ORG_ID, 5, { targetPostId: 10 });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
    const marked = updateSet.mock.calls.find(
      (c) => (c[0] as { mergedAt?: Date }).mergedAt instanceof Date,
    );
    expect(marked?.[0]).toMatchObject({ duplicateOfId: 10 });
    const repointed = updateSet.mock.calls.find(
      (c) => (c[0] as { mergedAt?: Date }).mergedAt === undefined,
    );
    expect(repointed?.[0]).toEqual({ duplicateOfId: 10 });
    expect(result).toBe(canonical);
  });
});
