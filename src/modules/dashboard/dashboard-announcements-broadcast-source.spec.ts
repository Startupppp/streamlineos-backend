import { desc } from "drizzle-orm";
import { broadcasts } from "../../db/schema";
import type { Db } from "../../db/drizzle.module";
import { DashboardAnnouncementsService } from "./dashboard-announcements.service";
import { BroadcastsService } from "../notifications/broadcasts.service";
import { fetchBroadcastItems } from "../notifications/unified-inbox-sources";

interface Chain extends Promise<unknown[]> {
  from: () => Chain;
  leftJoin: () => Chain;
  innerJoin: () => Chain;
  where: (w: unknown) => Chain;
  orderBy: (...o: unknown[]) => Chain;
  limit: () => Chain;
  values: (v: unknown) => Chain;
  set: (v: unknown) => Chain;
  returning: (p?: unknown) => Chain;
}

interface Recorder {
  wheres: unknown[];
  orderBys: unknown[];
  inserted: unknown[];
  deleted: number;
  rowQueue: unknown[][];
}

function newRecorder(rowQueue: unknown[][] = []): Recorder {
  return { wheres: [], orderBys: [], inserted: [], deleted: 0, rowQueue };
}

function makeChain(rec: Recorder, rows: unknown[]): Chain {
  const api: Chain = Object.assign(Promise.resolve(rows), {
    from: () => api,
    leftJoin: () => api,
    innerJoin: () => api,
    where: (w: unknown) => {
      rec.wheres.push(w);
      return api;
    },
    orderBy: (...o: unknown[]) => {
      rec.orderBys.push(...o);
      return api;
    },
    limit: () => api,
    values: (v: unknown) => {
      rec.inserted.push(v);
      return api;
    },
    set: () => api,
    returning: () => api,
  });
  return api;
}

function makeDb(rec: Recorder): Db {
  const next = (): unknown[] => rec.rowQueue.shift() ?? [];
  return {
    select: () => makeChain(rec, next()),
    insert: () => makeChain(rec, next()),
    delete: () => {
      rec.deleted += 1;
      return makeChain(rec, next());
    },
  } as unknown as Db;
}

function makeCache() {
  return {
    cachedForOrg: jest
      .fn()
      .mockImplementation((_orgId: unknown, _key: unknown, fn: () => unknown) => fn()),
    invalidateForOrg: jest.fn().mockResolvedValue(undefined),
    invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  };
}

interface Walked {
  values: unknown[];
  columns: string[];
}

function walk(node: unknown, seen = new Set<object>(), acc: Walked = { values: [], columns: [] }): Walked {
  if (node === null || node === undefined) return acc;
  if (typeof node === "string" || typeof node === "number" || typeof node === "boolean") {
    acc.values.push(node);
    return acc;
  }
  if (node instanceof Date) {
    acc.values.push(node);
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, seen, acc);
    return acc;
  }
  if (typeof node !== "object" || seen.has(node)) return acc;
  seen.add(node);
  const shape = node as {
    name?: unknown;
    columnType?: unknown;
    queryChunks?: unknown;
    value?: unknown;
  };
  if (typeof shape.name === "string" && typeof shape.columnType === "string") {
    acc.columns.push(shape.name);
    return acc;
  }
  if (shape.queryChunks !== undefined) walk(shape.queryChunks, seen, acc);
  if (Object.prototype.hasOwnProperty.call(shape, "value")) walk(shape.value, seen, acc);
  return acc;
}

function orderSignature(node: unknown): string {
  const shape = node as { queryChunks?: unknown[] };
  return (shape.queryChunks ?? [])
    .map((chunk) => {
      const part = chunk as { name?: unknown; value?: unknown };
      if (typeof part.name === "string") return part.name;
      if (Array.isArray(part.value)) return part.value.join("");
      return "";
    })
    .join("")
    .trim();
}

const ORG_A = "org-a";
const ORG_B = "org-b";
const ACTOR = { userId: "u-1", orgId: ORG_A, membershipId: 7 };

function allow() {
  return { holds: jest.fn().mockResolvedValue(true) } as never;
}

function deny() {
  return { holds: jest.fn().mockResolvedValue(false) } as never;
}

describe("Home announcements are broadcasts, so the unified Inbox can see them", () => {
  it("writes the row through the broadcasts table rather than announcements, which is the only table the Inbox reads", async () => {
    const rec = newRecorder([[{ id: 1, status: "SENT" }]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, {
      title: "All hands",
      content: "Friday 4pm",
    });

    expect(rec.inserted).toHaveLength(1);
    const values = rec.inserted[0] as Record<string, unknown>;
    expect(values.message).toBe("Friday 4pm");
    expect(values.orgId).toBe(ORG_A);
    expect(values.createdBy).toBe("u-1");
  });

  it("stamps the created row with exactly the status and audience listInboxPage requires, so posting on Home reaches the Inbox", async () => {
    const createRec = newRecorder([[{ id: 1, status: "SENT" }]]);
    const svc = new DashboardAnnouncementsService(makeDb(createRec), makeCache() as never, allow());
    await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, {
      title: "All hands",
      content: "Friday 4pm",
    });
    const created = createRec.inserted[0] as Record<string, unknown>;

    const inboxRec = newRecorder([[], [], []]);
    const broadcastsSvc = new BroadcastsService(
      makeDb(inboxRec),
      makeCache() as never,
      { log: jest.fn() } as never,
      { emit: jest.fn() } as never,
    );
    await broadcastsSvc.listInboxPage(ORG_A, "u-2", 20, null, 9);

    const inboxPredicate = walk(inboxRec.wheres);
    expect(inboxPredicate.values).toContain(created.status);
    expect(inboxPredicate.values).toContain(created.audienceType);
    expect(created.sentAt).toBeInstanceOf(Date);
  });

  it("refuses a DRAFT or targeted row as the Home shape, which is the negative that makes the visibility assertion mean something", async () => {
    const rec = newRecorder([[{ id: 1, status: "SENT" }]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());
    await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, { title: "t", content: "c" });
    const created = rec.inserted[0] as Record<string, unknown>;

    expect(created.status).not.toBe("DRAFT");
    expect(created.audienceType).not.toBe("users");
    expect(created.audienceType).not.toBe("departments");
    expect(created.audienceType).not.toBe("roles");
  });

  it("projects a broadcast into an inbox item, so the row the Home path writes renders in the unified Inbox", async () => {
    const sentAt = new Date("2026-01-05T10:00:00.000Z");
    const listInboxPage = jest.fn().mockResolvedValue([
      {
        id: 42,
        title: "All hands",
        message: "Friday 4pm",
        type: "INFO",
        priority: "NORMAL",
        category: "SYSTEM",
        sentAt,
        createdAt: sentAt,
      },
    ]);

    const items = await fetchBroadcastItems(
      { listInboxPage } as unknown as BroadcastsService,
      ORG_A,
      "u-2",
      20,
      null,
      9,
    );

    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("broadcast");
    expect(items[0].subject).toBe("All hands");
    expect(items[0].body).toBe("Friday 4pm");
  });
});

describe("Home announcements read path keeps its pre-cutover ordering, expiry and cap", () => {
  it("orders pinned first then newest, the same two keys the announcements query used", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.getActiveAnnouncements(ORG_A);

    expect(rec.orderBys).toHaveLength(2);
    expect(orderSignature(rec.orderBys[0])).toBe(orderSignature(desc(broadcasts.isPinned)));
    expect(orderSignature(rec.orderBys[1])).toBe(orderSignature(desc(broadcasts.createdAt)));
  });

  it("filters on expires_at so an expired announcement drops off Home, and on is_pinned so the order key is a real column", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.getActiveAnnouncements(ORG_A);

    const predicate = walk(rec.wheres);
    expect(predicate.columns).toContain("expires_at");
    expect(predicate.columns).toContain("is_pinned");
    expect(predicate.columns).toContain("status");
    expect(predicate.columns).toContain("audience_type");
  });

  it("returns rows for the owning org, the positive control for the two negative filters above", async () => {
    const row = {
      id: 1,
      content: "Friday 4pm",
      isPinned: true,
      expiresAt: null,
      createdAt: new Date("2026-01-05T10:00:00.000Z"),
      authorId: "u-1",
      authorName: "Ada",
      authorFirstName: "Ada",
      authorLastName: null,
    };
    const rec = newRecorder([[row]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    const result = await svc.getActiveAnnouncements(ORG_A);

    expect(result).toEqual([row]);
  });
});

describe("settings:manage still gates both Home announcement writes", () => {
  it("refuses create without settings:manage and writes nothing", async () => {
    const rec = newRecorder();
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, deny());

    const result = await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, {
      title: "t",
      content: "c",
    });

    expect(result).toEqual({ error: "forbidden", message: "Forbidden" });
    expect(rec.inserted).toHaveLength(0);
  });

  it("allows create with settings:manage, the positive control for the refusal above", async () => {
    const rec = newRecorder([[{ id: 1 }]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, { title: "t", content: "c" });

    expect(rec.inserted).toHaveLength(1);
  });

  it("refuses delete without settings:manage and issues no delete", async () => {
    const rec = newRecorder();
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, deny());

    const result = await svc.deleteAnnouncement(ORG_A, ACTOR as never, 5);

    expect(result).toEqual({ error: "forbidden", message: "Forbidden" });
    expect(rec.deleted).toBe(0);
  });

  it("allows delete with settings:manage, the positive control for the refusal above", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.deleteAnnouncement(ORG_A, ACTOR as never, 5);

    expect(rec.deleted).toBe(1);
  });
});

describe("an actor in org B cannot reach org A's announcement", () => {
  it("scopes the read to the caller's org and never to the other tenant", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.getActiveAnnouncements(ORG_B);

    const predicate = walk(rec.wheres);
    expect(predicate.values).toContain(ORG_B);
    expect(predicate.values).not.toContain(ORG_A);
  });

  it("scopes the delete to the caller's org, so org B deleting id 5 cannot match org A's row", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.deleteAnnouncement(ORG_B, ACTOR as never, 5);

    const predicate = walk(rec.wheres);
    expect(predicate.values).toContain(ORG_B);
    expect(predicate.values).toContain(5);
    expect(predicate.values).not.toContain(ORG_A);
  });

  it("scopes the read to org A when org A asks, the positive control for both exclusions above", async () => {
    const rec = newRecorder([[]]);
    const svc = new DashboardAnnouncementsService(makeDb(rec), makeCache() as never, allow());

    await svc.getActiveAnnouncements(ORG_A);

    const predicate = walk(rec.wheres);
    expect(predicate.values).toContain(ORG_A);
  });
});

describe("the new writer keeps both caches that now read broadcasts correct", () => {
  it("invalidates the Home announcements key and the broadcasts list namespace on create", async () => {
    const rec = newRecorder([[{ id: 1 }]]);
    const cache = makeCache();
    const svc = new DashboardAnnouncementsService(makeDb(rec), cache as never, allow());

    await svc.createAnnouncement(ORG_A, "u-1", ACTOR as never, { title: "t", content: "c" });

    expect(cache.invalidateForOrg).toHaveBeenCalledWith(ORG_A, `dashboard:announcements:${ORG_A}`);
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(`broadcasts:list:${ORG_A}`);
  });

  it("invalidates both on delete as well, because a delete changes the same two reads", async () => {
    const rec = newRecorder([[]]);
    const cache = makeCache();
    const svc = new DashboardAnnouncementsService(makeDb(rec), cache as never, allow());

    await svc.deleteAnnouncement(ORG_A, ACTOR as never, 5);

    expect(cache.invalidateForOrg).toHaveBeenCalledWith(ORG_A, `dashboard:announcements:${ORG_A}`);
    expect(cache.invalidateNamespace).toHaveBeenCalledWith(`broadcasts:list:${ORG_A}`);
  });
});
