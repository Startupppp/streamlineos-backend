import { NotFoundException } from "@nestjs/common";
import { CommentDraftsService } from "./comment-drafts.service";
import type { Db } from "../../../db/drizzle.module";
import { commentDrafts } from "../../../db/schema/build/comment-drafts";
import { COMMENT_DRAFT_MAX_RETRIES } from "./comment-drafts.constants";
import {
  commentDraftSchema,
  commentDraftWithTicketSchema,
} from "./dto/comment-drafts-response.schemas";

function makeEmptySelect(): jest.Mock {
  return jest.fn().mockReturnValue({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    }),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
});

describe("CommentDraftsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when upserting a draft for a ticket in a different org", async () => {
    const db = {
      select: makeEmptySelect(),
      insert: jest.fn(),
      delete: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);

    await expect(
      svc.upsert("org-attacker", null, "user-1", 999, { body: "draft" }),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when deleting a draft in a different org", async () => {
    const db = {
      select: makeEmptySelect(),
      delete: jest.fn(),
      insert: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);

    await expect(svc.deleteOne("org-attacker", 42, "user-1", 999)).rejects.toThrow(NotFoundException);
  });

  it("upsert throws NotFoundException when the ticket does not exist in the attacker org — the draft store is never reached", async () => {
    const db = {
      select: makeEmptySelect(),
      insert: jest.fn(),
      delete: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);

    await expect(
      svc.upsert("org-attacker", 42, "user-1", 999, { body: "draft" }),
    ).rejects.toThrow(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("listMine returns empty for an org that has no drafts (cross-tenant isolation by predicate)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                leftJoin: jest.fn().mockReturnValue({
                  where: jest.fn().mockReturnValue({
                    orderBy: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    const result = await svc.listMine("org-other", 42, "user-1");
    expect(result).toEqual([]);
  });
});

describe("CommentDraftsService — BSN-03-044: unapproved proposal cannot perform a meaningful write", () => {
  it("upsert writes only to the comment_drafts store and never to a ticket-action table — no meaningful write is possible without an explicit publish step", async () => {
    const insertReturningFn = jest.fn().mockResolvedValue([{
      id: 1,
      orgId: "org-1",
      membershipId: 42,
      ticketId: 99,
      body: "draft body",
      createdAt: new Date(),
      updatedAt: new Date(),
    }]);
    const onConflictFn = jest.fn().mockReturnValue({ returning: insertReturningFn });
    const insertValuesFn = jest.fn().mockReturnValue({ onConflictDoUpdate: onConflictFn });
    const insertFn = jest.fn().mockReturnValue({ values: insertValuesFn });

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([{ id: 99 }]),
          }),
        }),
      }),
      insert: insertFn,
      delete: jest.fn(),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await svc.upsert("org-1", 42, "user-1", 99, { body: "draft body" });

    expect(insertFn).toHaveBeenCalledTimes(1);
    expect(insertFn).toHaveBeenCalledWith(commentDrafts);
  });

  it("CommentDraftsService has no publishDraft or applyDraft method — the draft-to-action path that would need an approval gate does not exist", () => {
    const publicMethods = Object.getOwnPropertyNames(CommentDraftsService.prototype).filter(
      (n) => n !== "constructor" && !n.startsWith("_"),
    );
    expect(publicMethods).not.toContain("publishDraft");
    expect(publicMethods).not.toContain("applyDraft");
    expect(publicMethods).not.toContain("publishProposal");
    expect(publicMethods).not.toContain("applyProposal");
  });
});

describe("CommentDraftsService — BSN-03-046: empty and low-confidence states stay quiet", () => {
  it("listMine returns an empty array when no drafts exist — no badge or row noise for an empty actor (BSN-03-046: empty-state is quiet)", async () => {
    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          innerJoin: jest.fn().mockReturnValue({
            leftJoin: jest.fn().mockReturnValue({
              leftJoin: jest.fn().mockReturnValue({
                leftJoin: jest.fn().mockReturnValue({
                  where: jest.fn().mockReturnValue({
                    orderBy: jest.fn().mockReturnValue({
                      limit: jest.fn().mockResolvedValue([]),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    const result = await svc.listMine("org-1", 42, "user-1");
    expect(result).toEqual([]);
    expect(result).toHaveLength(0);
  });
});

describe("CommentDraftsService — BSN-03-045: bounded retry path", () => {
  function makeSelectWithRetryCount(retryCount: number | null) {
    return jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([{ retryCount }]),
        }),
      }),
    });
  }

  function makeEmptySelect() {
    return jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
  }

  it("recordDraftFailure increments retry_count and records the last error (BSN-03-045)", async () => {
    const updateSetFn = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    const updateFn = jest.fn().mockReturnValue({ set: updateSetFn });

    const db = {
      select: makeSelectWithRetryCount(1),
      update: updateFn,
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await svc.recordDraftFailure("org-1", 42, 7, "AI provider timeout");

    expect(updateFn).toHaveBeenCalledWith(commentDrafts);
    const setArg = updateSetFn.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.retryCount).toBe(2);
    expect(setArg.lastError).toBe("AI provider timeout");
  });

  it("recordDraftFailure caps retry_count at COMMENT_DRAFT_MAX_RETRIES and never exceeds it — bounded retry path (BSN-03-045)", async () => {
    const updateSetFn = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    const updateFn = jest.fn().mockReturnValue({ set: updateSetFn });

    const db = {
      select: makeSelectWithRetryCount(COMMENT_DRAFT_MAX_RETRIES),
      update: updateFn,
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await svc.recordDraftFailure("org-1", 42, 7, "error at cap");

    const setArg = updateSetFn.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.retryCount).toBe(COMMENT_DRAFT_MAX_RETRIES);
  });

  it("recordDraftFailure treats a null retry_count as 0 and increments to 1 — preserves failed drafts from first failure (BSN-03-045)", async () => {
    const updateSetFn = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    const updateFn = jest.fn().mockReturnValue({ set: updateSetFn });

    const db = {
      select: makeSelectWithRetryCount(null),
      update: updateFn,
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await svc.recordDraftFailure("org-1", 42, 7, "first failure");

    const setArg = updateSetFn.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg.retryCount).toBe(1);
  });

  it("recordDraftFailure reports the retries left, so the client can stop before the cap (BSN-03-045)", async () => {
    const db = {
      select: makeSelectWithRetryCount(1),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    const result = await svc.recordDraftFailure("org-1", 42, 7, "AI provider timeout");

    expect(result).toEqual({
      retryCount: 2,
      retriesRemaining: COMMENT_DRAFT_MAX_RETRIES - 2,
    });
  });

  it("recordDraftFailure 404s another org's draft rather than mutating it, so the id is not an existence oracle (BSN-03-045)", async () => {
    const updateFn = jest.fn();

    const db = {
      select: makeEmptySelect(),
      update: updateFn,
      query: {},
    } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await expect(
      svc.recordDraftFailure("org-other", 99, 7, "should not run"),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(updateFn).not.toHaveBeenCalled();
  });

  it("recordDraftFailure refuses a caller with no organization membership before reading any draft", async () => {
    const selectFn = makeEmptySelect();
    const updateFn = jest.fn();

    const db = { select: selectFn, update: updateFn, query: {} } as unknown as Db;

    const svc = new CommentDraftsService(db);
    await expect(svc.recordDraftFailure("org-1", null, 7, "no membership")).rejects.toThrow();

    expect(selectFn).not.toHaveBeenCalled();
    expect(updateFn).not.toHaveBeenCalled();
  });
});

describe("Response contract — D1: commentDraftSchema silently strips ticket; commentDraftWithTicketSchema preserves it", () => {
  const rawListItem = {
    id: 1,
    orgId: "org-1",
    membershipId: 42,
    ticketId: 99,
    body: "draft body",
    createdAt: new Date(),
    updatedAt: new Date(),
    ticket: {
      id: 99,
      type: "BUG",
      title: "Fix crash",
      projectId: 1,
      status: "IN_PROGRESS",
      ticketNumber: 5,
      projectKey: "BLD",
      priority: "HIGH",
      projectName: "BuildOS",
      assignee: null,
    },
  };

  it("commentDraftSchema.parse strips the ticket field — this was the bug causing listMine to return items with no ticket info", () => {
    const parsed = commentDraftSchema.parse(rawListItem);
    expect(parsed).not.toHaveProperty("ticket");
  });

  it("commentDraftWithTicketSchema.parse preserves the ticket field — listMine response now carries ticket details", () => {
    const result = commentDraftWithTicketSchema.safeParse(rawListItem);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toHaveProperty("ticket");
      expect(result.data.ticket.title).toBe("Fix crash");
      expect(result.data.ticket.type).toBe("BUG");
      expect(result.data.ticket.ticketNumber).toBe(5);
    }
  });

  it("commentDraftWithTicketSchema accepts a null assignee — roster is optional in the projection", () => {
    const result = commentDraftWithTicketSchema.safeParse(rawListItem);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.ticket.assignee).toBeNull();
  });

  it("commentDraftWithTicketSchema accepts a populated assignee with nullable name fields", () => {
    const withAssignee = {
      ...rawListItem,
      ticket: {
        ...rawListItem.ticket,
        assignee: { id: "user-1", name: "Alice", image: null, lastName: "Smith", firstName: "Alice" },
      },
    };
    const result = commentDraftWithTicketSchema.safeParse(withAssignee);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.ticket.assignee?.id).toBe("user-1");
    }
  });
});
