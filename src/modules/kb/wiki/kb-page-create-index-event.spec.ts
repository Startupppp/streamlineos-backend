import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../../db/drizzle.module";
import { outboxEvents } from "../../../db/schema/common/outbox";
import { KbPagesService } from "./kb-pages.service";
import { KbPageWriterService } from "./kb-page-writer.service";

jest.mock("../../build/core/project-access", () => ({
  resolveProjectAccess: jest
    .fn()
    .mockResolvedValue({ hasAccess: true, role: "MEMBER" }),
}));

const ORG_ID = "org-create-index";
const PAGE_ID = 4242;

type Row = Record<string, unknown>;

function makeUser() {
  return {
    orgId: ORG_ID,
    userId: "user-1",
    isOrgOwner: false,
    principal: { kind: "human-session", membershipId: 1 },
  } as never;
}

interface CreateHarness {
  db: Db;
  outboxRows: Row[];
  pageValues: Row[];
  insertOrder: string[];
  insertOnPooledHandle: jest.Mock;
  outboxRowsWhenCallbackReturned: () => number;
}

function makeHarness(
  options: { template?: { content: unknown }; insertReturnsNoRow?: boolean } = {},
): CreateHarness {
  const outboxRows: Row[] = [];
  const pageValues: Row[] = [];
  const insertOrder: string[] = [];
  let outboxAtReturn = -1;

  const makeInsert = (handle: string): jest.Mock =>
    jest.fn((table: unknown) => ({
      values: (values: Row) => {
        if (table === outboxEvents) {
          insertOrder.push(`${handle}:outbox`);
          outboxRows.push(values);
          return Promise.resolve(undefined);
        }
        insertOrder.push(`${handle}:page`);
        pageValues.push(values);
        return {
          returning: (): Promise<Row[]> =>
            Promise.resolve(
              options.insertReturnsNoRow === true
                ? []
                : [
                    {
                      id: PAGE_ID,
                      orgId: ORG_ID,
                      contentRevision: 1,
                      aclRevision: 1,
                      ...values,
                    },
                  ],
            ),
        };
      },
    }));

  const makeUpdateChain = () => ({
    set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
  });

  const insertOnPooledHandle = makeInsert("db");
  const tx = {
    insert: makeInsert("tx"),
    update: jest.fn().mockImplementation(makeUpdateChain),
  };

  const db = {
    query: {
      kbPageTemplates: { findFirst: jest.fn().mockResolvedValue(options.template) },
      kbPages: { findFirst: jest.fn().mockResolvedValue(undefined) },
      kbSpaces: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
    insert: insertOnPooledHandle,
    update: jest.fn().mockImplementation(makeUpdateChain),
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(tx);
      outboxAtReturn = outboxRows.length;
      return result;
    }),
  } as unknown as Db;

  return {
    db,
    outboxRows,
    pageValues,
    insertOrder,
    insertOnPooledHandle,
    outboxRowsWhenCallbackReturned: () => outboxAtReturn,
  };
}

function makeService(db: Db): KbPagesService {
  return new KbPagesService(
    db,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    {} as never,
    {} as never,
    {} as never,
    new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never),
  );
}

function indexEventsOf(rows: Row[]): Row[] {
  return rows.filter((row) => row.eventType === "kb.content.index");
}

describe("KbPagesService.create — indexing a page at the moment it is created", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("indexes a page the moment it is created, because a page only the backfill could rescue is one the backfill filters out", async () => {
    const harness = makeHarness();

    const page = await makeService(harness.db).create(makeUser(), {
      title: "Runbook",
    });

    const events = indexEventsOf(harness.outboxRows);
    expect(events).toHaveLength(1);
    expect(events[0]?.aggregateType).toBe("kb_page");
    expect(events[0]?.aggregateId).toBe(String(page.id));
    expect(events[0]?.payload).toMatchObject({
      contentType: "page",
      contentId: page.id,
      contentRevision: 1,
      aclRevision: 1,
    });
  });

  it("writes the index event through the transaction handle that inserted the page, because an event written on the pooled handle outlives a rolled back create", async () => {
    const harness = makeHarness();

    await makeService(harness.db).create(makeUser(), { title: "Runbook" });

    expect(harness.insertOrder).toEqual(["tx:page", "tx:outbox"]);
    expect(harness.insertOnPooledHandle).not.toHaveBeenCalled();
    expect(harness.outboxRowsWhenCallbackReturned()).toBe(1);
  });

  it("stores a content_text that satisfies the backfill's own isNotNull + trim predicate, which is the gate a newly created page has to clear to be swept", async () => {
    const backfillSource = readFileSync(
      join(__dirname, "..", "retrieval", "kb-page-backfill.service.ts"),
      "utf8",
    );
    expect(backfillSource).toContain("isNotNull(kbPages.contentText)");
    expect(backfillSource).toContain("trim(${kbPages.contentText}) != ''");

    const harness = makeHarness();
    await makeService(harness.db).create(makeUser(), {
      title: "Onboarding runbook",
    });

    const stored = harness.pageValues[0]?.contentText;
    expect(typeof stored).toBe("string");
    const isNotNull = stored !== null && stored !== undefined;
    const trimIsNotEmpty = isNotNull && String(stored).trim() !== "";
    expect(isNotNull && trimIsNotEmpty).toBe(true);
  });

  it("carries the template's own words into content_text, because a page created from a template holds text nobody typed into the create request", async () => {
    const harness = makeHarness({
      template: {
        content: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Escalate to the on-call engineer" },
              ],
            },
          ],
        },
      },
    });

    await makeService(harness.db).create(makeUser(), {
      title: "Incident",
      templateId: 5,
    });

    expect(harness.pageValues[0]?.contentText).toBe(
      "Escalate to the on-call engineer",
    );
    expect(indexEventsOf(harness.outboxRows)).toHaveLength(1);
  });

  it("records no event when the insert returns no row, proving the recorder reports emissions the service made rather than emissions the test assumed", async () => {
    const harness = makeHarness({ insertReturnsNoRow: true });

    await expect(
      makeService(harness.db).create(makeUser(), { title: "Runbook" }),
    ).rejects.toThrow("Failed to create page");

    expect(harness.outboxRows).toHaveLength(0);
  });
});

describe("KbPagesService.create — writer delegation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("delegates to writer.commitPageChange so the event path flows through the canonical seam", async () => {
    const harness = makeHarness();
    const writer = new KbPageWriterService({} as never, { logCritical: jest.fn().mockResolvedValue(undefined), log: jest.fn() } as never);
    const spy = jest.spyOn(writer, "commitPageChange").mockResolvedValue(undefined);
    const svc = new KbPagesService(
      harness.db,
      { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
      {} as never,
      {} as never,
      {} as never,
      writer,
    );

    await svc.create(makeUser(), { title: "Runbook" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        orgId: ORG_ID,
        page: expect.objectContaining({ contentRevision: 1 }),
      }),
    );
  });
});
