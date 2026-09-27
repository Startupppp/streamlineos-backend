import { sql } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { outboxEvents } from "../../../db/schema/common/outbox";
import { KbPageDuplicateService } from "./kb-page-duplicate.service";
import { KbPageTreeService } from "./kb-page-tree.service";
import { KbPageWriterService } from "./kb-page-writer.service";

const ORG_ID = "org-index-events";
const PAGE_ID = 42;
const COPY_ID = 99;

type Row = Record<string, unknown>;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

function makeAuth() {
  return {
    visiblePagePredicate: jest.fn().mockResolvedValue(sql`true`),
    assertPageAccess: jest.fn().mockResolvedValue({
      orgId: ORG_ID,
      pageId: PAGE_ID,
      action: "edit",
      via: "admin",
    }),
  } as never;
}

function recordingInsert(outboxRows: Row[], returningRows: Row[]): jest.Mock {
  return jest.fn((table: unknown) => ({
    values: (values: Row | Row[]) => {
      if (table === outboxEvents) {
        for (const row of Array.isArray(values) ? values : [values])
          outboxRows.push(row);
        return Promise.resolve(undefined);
      }
      return { returning: (): Promise<Row[]> => Promise.resolve(returningRows) };
    },
  }));
}

function indexEventsOf(rows: Row[]): Row[] {
  return rows.filter((row) => row.eventType === "kb.content.index");
}

function makeDuplicateHarness(contentText: string): {
  db: Db;
  outboxRows: Row[];
} {
  const outboxRows: Row[] = [];
  const original = {
    id: PAGE_ID,
    orgId: ORG_ID,
    parentPageId: null,
    spaceId: null,
    title: "Runbook",
    icon: null,
    coverImage: null,
    content: null,
    contentText,
    sortOrder: 100,
  };
  const copy = {
    ...original,
    id: COPY_ID,
    title: "Runbook (copy)",
    sortOrder: 100,
    contentRevision: 1,
    aclRevision: 1,
  };

  const where = jest
    .fn()
    .mockReturnValueOnce(Promise.resolve([original]))
    .mockReturnValueOnce({
      orderBy: jest.fn().mockReturnValue({
        limit: jest.fn().mockResolvedValue([]),
      }),
    });

  const tx = {
    execute: jest.fn().mockResolvedValue([{ id: PAGE_ID }]),
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
    insert: recordingInsert(outboxRows, [copy]),
  };

  const db = {
    query: { kbPages: { findFirst: jest.fn().mockResolvedValue({ id: PAGE_ID }) } },
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, outboxRows };
}

function makeMoveHarness(updatedRows: Row[]): { db: Db; outboxRows: Row[] } {
  const outboxRows: Row[] = [];

  const tx = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(updatedRows),
        }),
      }),
    }),
    insert: recordingInsert(outboxRows, []),
  };

  const db = {
    query: {
      kbPages: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: PAGE_ID, parentPageId: null, spaceId: null }),
      },
    },
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;

  return { db, outboxRows };
}

describe("KbPageDuplicateService.duplicate — indexing the copy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits one kb.content.index event for the copy, because a duplicated page carries text no later edit is guaranteed to touch", async () => {
    const harness = makeDuplicateHarness("escalation steps");
    const svc = new KbPageDuplicateService(
      harness.db,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      makeAuth(),
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    const copy = await svc.duplicate(makeUser(), PAGE_ID);

    const events = indexEventsOf(harness.outboxRows);
    expect(events).toHaveLength(1);
    expect(events[0]?.aggregateId).toBe(String(copy.id));
    expect(events[0]?.payload).toMatchObject({
      contentType: "page",
      contentId: COPY_ID,
    });
  });

  it("emits nothing for a copy whose source had no text, proving the recorder counts events the service emitted rather than every insert it made", async () => {
    const harness = makeDuplicateHarness("");
    const svc = new KbPageDuplicateService(
      harness.db,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      makeAuth(),
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await svc.duplicate(makeUser(), PAGE_ID);

    expect(harness.outboxRows).toHaveLength(0);
  });
});

describe("KbPageTreeService.move — indexing the moved page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("emits one kb.content.index event for the moved page, because a move rewrites the space the index resolves access against", async () => {
    const harness = makeMoveHarness([
      { id: PAGE_ID, contentRevision: 3, aclRevision: 2 },
    ]);
    const svc = new KbPageTreeService(
      harness.db,
      { log: jest.fn() } as never,
      makeAuth(),
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await svc.move(makeUser(), PAGE_ID, { parentPageId: null, index: 0 });

    const events = indexEventsOf(harness.outboxRows);
    expect(events).toHaveLength(1);
    expect(events[0]?.aggregateId).toBe(String(PAGE_ID));
    expect(events[0]?.payload).toMatchObject({
      contentType: "page",
      contentId: PAGE_ID,
      contentRevision: 3,
      aclRevision: 2,
    });
  });

  it("emits nothing when the move updates no row, so a failed move cannot leave an index event behind", async () => {
    const harness = makeMoveHarness([]);
    const svc = new KbPageTreeService(
      harness.db,
      { log: jest.fn() } as never,
      makeAuth(),
      {} as never,
      new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
    );

    await expect(
      svc.move(makeUser(), PAGE_ID, { parentPageId: null, index: 0 }),
    ).rejects.toThrow("Page not found");

    expect(harness.outboxRows).toHaveLength(0);
  });
});

describe("KbPageDuplicateService.duplicate — writer delegation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delegates to writer.commitManyPageChanges so the copy batch flows through the canonical seam", async () => {
    const harness = makeDuplicateHarness("escalation steps");
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
    const spy = jest.spyOn(writer, "commitManyPageChanges").mockResolvedValue(undefined);
    const svc = new KbPageDuplicateService(
      harness.db,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      makeAuth(),
      writer,
    );

    await svc.duplicate(makeUser(), PAGE_ID);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG_ID }),
    );
  });
});

describe("KbPageTreeService.move — writer delegation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delegates to writer.commitPageChange so the reindex event flows through the canonical seam", async () => {
    const harness = makeMoveHarness([
      { id: PAGE_ID, contentRevision: 3, aclRevision: 2 },
    ]);
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = new KbPageTreeService(
      harness.db,
      { log: jest.fn() } as never,
      makeAuth(),
      {} as never,
      writer,
    );

    await svc.move(makeUser(), PAGE_ID, { parentPageId: null, index: 0 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        page: expect.objectContaining({ id: PAGE_ID }),
      }),
    );
  });
});
