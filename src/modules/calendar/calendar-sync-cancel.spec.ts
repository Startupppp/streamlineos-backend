import { NotFoundException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { CalendarSyncStatusService } from "./calendar-sync-status.service";

/**
 * Cancellation — the half of PRD-C129's "retry/backoff and cancellation" that did not
 * exist.
 *
 * `calendar_provider_sync_queue` had exactly one lifecycle control, `retrySync`, which
 * revives a FAILED row. There was no way to withdraw a job that had not been dispatched:
 * a sync queued against the wrong connection, or one the person changed their mind about
 * before the next 120-second tick, could only be pushed or exhausted.
 *
 * The predicate is the whole design, so it is asserted as SQL rather than inferred from a
 * mock's return value: `state = 'PENDING'` and nothing else. An IN_FLIGHT row is being
 * pushed right now and deleting it would destroy the only record of a write that may
 * already have reached the provider; a FAILED row carries the reason `getSyncStatus`
 * reports, so removing it would erase a divergence the user is entitled to see. A mocked
 * `delete` cannot enforce any of that — only the emitted WHERE clause can.
 */
const dialect = new PgDialect();

const ORG = "org-cancel";
const OTHER_ORG = "org-cancel-other";
const CREATOR = "user-creator";
const BYSTANDER = "user-bystander";
const EVENT_ID = 88;
const CREATOR_MEMBERSHIP = 12;
const OTHER_MEMBERSHIP = 34;

function makeDb(opts: {
  memberRow?: { id: number };
  visibleEvent?: { id: number; createdByMembershipId: number };
  tombstoneRows?: unknown[];
  deleteReturning?: { id: number }[];
  captureDeleteWhere?: (pred: SQL) => void;
}): Db {
  const {
    memberRow,
    visibleEvent,
    tombstoneRows = [],
    deleteReturning = [],
    captureDeleteWhere,
  } = opts;

  const visibilityFrom = jest.fn().mockReturnValue({
    leftJoin: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(visibleEvent ? [visibleEvent] : []),
      }),
    }),
  });

  const tombstoneFrom = jest.fn().mockReturnValue({
    where: jest.fn().mockReturnValue({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue(tombstoneRows),
      }),
    }),
  });

  let call = 0;
  const select = jest.fn().mockImplementation(() => {
    call += 1;
    return call === 1 ? { from: visibilityFrom } : { from: tombstoneFrom };
  });

  const del = jest.fn().mockReturnValue({
    where: jest.fn().mockImplementation((pred: SQL) => {
      captureDeleteWhere?.(pred);
      return { returning: jest.fn().mockResolvedValue(deleteReturning) };
    }),
  });

  return {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(memberRow) } },
    select,
    delete: del,
  } as unknown as Db;
}

const creatorEvent = { id: EVENT_ID, createdByMembershipId: CREATOR_MEMBERSHIP };

beforeEach(() => jest.resetAllMocks());

describe("CalendarSyncStatusService.cancelSync", () => {
  it("BITE: withdraws the undispatched jobs and reports how many", async () => {
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: creatorEvent,
      deleteReturning: [{ id: 1 }, { id: 2 }],
    });

    const result = await new CalendarSyncStatusService(db).cancelSync(ORG, CREATOR, EVENT_ID);

    expect(result).toEqual({ cancelled: 2 });
  });

  it("BITE: cancels only PENDING rows, scoped to the org and the event", async () => {
    let captured: SQL | undefined;
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: creatorEvent,
      deleteReturning: [{ id: 1 }],
      captureDeleteWhere: (pred) => {
        captured = pred;
      },
    });

    await new CalendarSyncStatusService(db).cancelSync(ORG, CREATOR, EVENT_ID);

    expect(captured).toBeDefined();
    const { sql, params } = dialect.sqlToQuery(captured as SQL);
    expect(sql).toContain("org_id");
    expect(sql).toContain("event_id");
    expect(sql).toContain("state");
    expect(params).toContain(ORG);
    expect(params).toContain(EVENT_ID);
    expect(params).toContain("PENDING");
    // The three states a cancellation must never touch.
    expect(params).not.toContain("IN_FLIGHT");
    expect(params).not.toContain("PROCESSED");
    expect(params).not.toContain("FAILED");
    expect(params).not.toContain(OTHER_ORG);
  });

  it("reports zero rather than failing when the sweep already claimed the job", async () => {
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: creatorEvent,
      deleteReturning: [],
    });

    const result = await new CalendarSyncStatusService(db).cancelSync(ORG, CREATOR, EVENT_ID);

    expect(result).toEqual({ cancelled: 0 });
  });

  it("BITE: someone who can merely see the event cannot cancel its sync", async () => {
    // Same bar as retrySync. The event is org-visible, so `assertReadable` passes and the
    // creator check is the only thing standing between a colleague and this queue.
    const db = makeDb({
      memberRow: { id: OTHER_MEMBERSHIP },
      visibleEvent: creatorEvent,
    });

    await expect(
      new CalendarSyncStatusService(db).cancelSync(ORG, BYSTANDER, EVENT_ID),
    ).rejects.toThrow(NotFoundException);
    expect((db as unknown as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it("BITE: a bystander gets a 404 for an event with no visibility and no tombstone", async () => {
    const db = makeDb({
      memberRow: { id: OTHER_MEMBERSHIP },
      visibleEvent: undefined,
      tombstoneRows: [],
    });

    await expect(
      new CalendarSyncStatusService(db).cancelSync(ORG, BYSTANDER, EVENT_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it("lets the person who issued a delete withdraw its orphaned tombstone job", async () => {
    // The local row is gone, so visibility resolves from the tombstone's own author —
    // exactly the path getSyncStatus and retrySync already use.
    const db = makeDb({
      memberRow: { id: CREATOR_MEMBERSHIP },
      visibleEvent: undefined,
      tombstoneRows: [{ id: 5 }],
      deleteReturning: [{ id: 5 }],
    });

    const result = await new CalendarSyncStatusService(db).cancelSync(ORG, CREATOR, EVENT_ID);

    expect(result).toEqual({ cancelled: 1 });
  });
});
