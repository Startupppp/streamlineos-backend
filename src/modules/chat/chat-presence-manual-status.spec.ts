import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.module";
import { ChatPresenceService } from "./chat-presence.service";
import {
  AUTO_PRESENCE_STATUSES,
  MANUAL_PRESENCE_STATUSES,
  PRESENCE_CLEAR_AFTER_OPTIONS,
  PRESENCE_STATUSES,
  PRESENCE_STATUS_MESSAGE_MAX_LENGTH,
  isAutoPresenceStatus,
  presenceStatusExpiry,
} from "./chat-presence-status";
import { statusSchema, type StatusInput } from "./dto/chat.schemas";
import { chatOnlineResponseSchema } from "./dto/chat-presence-response-schema";

const dialect = new PgDialect();

function isSql(value: unknown): value is SQL {
  return value instanceof SQL;
}

function renderSet(set: Record<string, unknown> | undefined): string {
  return Object.values(set ?? {})
    .filter(isSql)
    .map((fragment) => dialect.sqlToQuery(fragment).sql)
    .join(" | ");
}

describe("presence status vocabulary", () => {
  it("offers every availability option the product asks for", () => {
    expect(PRESENCE_STATUSES).toEqual([
      "ONLINE",
      "AWAY",
      "OFFLINE",
      "BUSY",
      "DO_NOT_DISTURB",
      "IN_A_MEETING",
      "ON_LEAVE",
      "VACATION",
      "WORKING_REMOTELY",
    ]);
  });

  it("accepts a manually chosen status the old three-value schema would have rejected", () => {
    expect(statusSchema.safeParse({ status: "DO_NOT_DISTURB" }).success).toBe(true);
    expect(statusSchema.safeParse({ status: "ON_LEAVE" }).success).toBe(true);
  });

  it("still rejects a status outside the vocabulary", () => {
    expect(statusSchema.safeParse({ status: "PARTYING" }).success).toBe(false);
  });

  it("classifies only the activity-derived three as automatic, so the heartbeat knows what it may overwrite", () => {
    for (const status of AUTO_PRESENCE_STATUSES) expect(isAutoPresenceStatus(status)).toBe(true);
    for (const status of MANUAL_PRESENCE_STATUSES) expect(isAutoPresenceStatus(status)).toBe(false);
  });
});

interface CapturedUpsert {
  values?: Record<string, unknown>;
  set?: Record<string, unknown>;
}

function makeDb(captured: CapturedUpsert) {
  const onConflictDoUpdate = jest.fn((config: { set: Record<string, unknown> }) => {
    captured.set = config.set;
    return Promise.resolve(undefined);
  });
  const values = jest.fn((row: Record<string, unknown>) => {
    captured.values = row;
    return { onConflictDoUpdate };
  });
  return {
    query: {
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 11 }) },
    },
    insert: jest.fn(() => ({ values })),
  };
}

describe("ChatPresenceService.heartbeat", () => {
  it("writes a conditional status expression rather than forcing ONLINE, so a manual Do Not Disturb survives the next beat", async () => {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);

    await service.heartbeat("user-1", "org-1");

    expect(captured.set).toBeDefined();
    expect(captured.set?.status).not.toBe("ONLINE");
    expect(typeof captured.set?.status).toBe("object");
  });

  it("still refreshes lastSeenAt on every beat, which is what auto-away is derived from", async () => {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);

    await service.heartbeat("user-1", "org-1");

    expect(captured.set?.lastSeenAt).toBeInstanceOf(Date);
  });

  it("leaves an UNEXPIRED manual status and its message untouched, so a beat mid-meeting does not wipe what the member typed", async () => {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);

    await service.heartbeat("user-1", "org-1");

    const clause = renderSet(captured.set);
    expect(clause).toMatch(/else "chat_user_presence"\."status" end/i);
    expect(clause).toMatch(/else "chat_user_presence"\."status_message" end/i);
    expect(clause).toMatch(/else "chat_user_presence"\."status_expires_at" end/i);
  });

  it("self-heals an EXPIRED manual status back to the activity-derived one and clears its message, so no sweep job is needed", async () => {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);

    await service.heartbeat("user-1", "org-1");

    const clause = renderSet(captured.set);
    expect(clause).toMatch(
      /"chat_user_presence"\."status_expires_at" is not null and "chat_user_presence"\."status_expires_at" <= \$\d+::timestamp/i,
    );
    expect(clause).toMatch(/when .* then null else "chat_user_presence"\."status_message" end/i);
  });

  it("binds the expiry comparison as an ISO string rather than a Date, which postgres-js cannot serialise inside a raw template", async () => {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);

    await service.heartbeat("user-1", "org-1");

    const status = captured.set?.status;
    if (!isSql(status)) throw new Error("heartbeat stopped writing a conditional status");
    for (const param of dialect.sqlToQuery(status).params)
      expect(param).not.toBeInstanceOf(Date);
  });
});

describe("ChatPresenceService.setStatus", () => {
  async function upsertFor(body: StatusInput): Promise<CapturedUpsert> {
    const captured: CapturedUpsert = {};
    const service = new ChatPresenceService(makeDb(captured) as never, {} as never);
    await service.setStatus("user-1", "org-1", body);
    return captured;
  }

  it("stores the custom message the member typed, on the insert and the conflict update alike", async () => {
    const captured = await upsertFor({ status: "BUSY", statusMessage: "Heads-down until 3pm" });

    expect(captured.values?.statusMessage).toBe("Heads-down until 3pm");
    expect(captured.set?.statusMessage).toBe("Heads-down until 3pm");
  });

  it("treats an empty message as a clear rather than storing a blank string nobody can distinguish from one", async () => {
    const captured = await upsertFor({ status: "ONLINE", statusMessage: "" });

    expect(captured.values?.statusMessage).toBeNull();
    expect(captured.set?.statusMessage).toBeNull();
  });

  it("omitting clearAfter leaves the status standing until the member clears it", async () => {
    const captured = await upsertFor({ status: "VACATION" });

    expect(captured.values?.statusExpiresAt).toBeNull();
    expect(captured.set?.statusExpiresAt).toBeNull();
  });

  it("derives the expiry from the SERVER clock, so a client cannot post an arbitrary timestamp", async () => {
    const before = Date.now();
    const captured = await upsertFor({ status: "IN_A_MEETING", clearAfter: "1h" });
    const after = Date.now();

    const expiry = captured.values?.statusExpiresAt;
    if (!(expiry instanceof Date)) throw new Error("setStatus did not compute an expiry");
    expect(expiry.getTime()).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(expiry.getTime()).toBeLessThanOrEqual(after + 60 * 60 * 1000);
  });
});

describe("presenceStatusExpiry", () => {
  const from = new Date("2026-09-18T09:30:00.000Z");

  it("maps 1h to exactly one hour from now", () => {
    expect(presenceStatusExpiry("1h", from)?.toISOString()).toBe("2026-09-18T10:30:00.000Z");
  });

  it("maps today to the end of the caller's UTC day, not to a rolling 24 hours", () => {
    expect(presenceStatusExpiry("today", from)?.toISOString()).toBe("2026-09-18T23:59:59.999Z");
  });

  it("maps week to seven days from now", () => {
    expect(presenceStatusExpiry("week", from)?.toISOString()).toBe("2026-09-25T09:30:00.000Z");
  });

  it("maps never to no expiry at all", () => {
    expect(presenceStatusExpiry("never", from)).toBeNull();
  });

  it("does not mutate the instant it was given", () => {
    presenceStatusExpiry("today", from);
    expect(from.toISOString()).toBe("2026-09-18T09:30:00.000Z");
  });
});

describe("ChatPresenceService.getOnlineUsers — expiry is enforced on the read, with no sweep job", () => {
  function onlineSql(): string {
    const offline = drizzle(postgres("postgres://unused@127.0.0.1:1/unused", { max: 1 }));
    const service = new ChatPresenceService(offline as unknown as Db, {} as never);
    return service.selectOnlineUsers("org-1").toSQL().sql;
  }

  it("reads an expired manual status as the activity-derived one rather than the stale stored value", () => {
    expect(onlineSql()).toMatch(
      /case when "chat_user_presence"\."status_expires_at" is not null and "chat_user_presence"\."status_expires_at" <= \$\d+::timestamp then \$\d+::text else "chat_user_presence"\."status" end/i,
    );
  });

  it("reads a null message for an expired row, so the stale 'Heads-down until 3pm' disappears with the status", () => {
    expect(onlineSql()).toMatch(
      /then null else "chat_user_presence"\."status_message" end/i,
    );
    expect(onlineSql()).toMatch(
      /then null else "chat_user_presence"\."status_expires_at" end/i,
    );
  });

  it("stays a single query, so expiry costs no extra round trip", () => {
    const sqlText = onlineSql();
    expect(sqlText.match(/\bselect\b/gi)).toHaveLength(1);
    expect(sqlText).toContain("limit");
  });

  it("turns a string timestamp from the CASE expression into a Date, which is what the response schema accepts", async () => {
    const rows = [
      {
        userId: "user-a",
        status: "BUSY",
        statusMessage: "Heads-down until 3pm",
        statusExpiresAt: "2026-09-18T15:00:00.000Z",
        lastSeenAt: "2026-09-18T09:30:00.000Z",
        userName: null,
        userImage: null,
      },
    ];
    const db = {
      select: jest.fn(() => ({
        from: () => ({
          innerJoin: () => ({
            innerJoin: () => ({
              where: () => ({
                limit: () => Promise.resolve(rows),
              }),
            }),
          }),
        }),
      })),
    };
    const service = new ChatPresenceService(db as never, {} as never);
    const [row] = await service.getOnlineUsers("org-1");
    expect(row?.lastSeenAt).toBeInstanceOf(Date);
    expect(row?.statusExpiresAt).toBeInstanceOf(Date);
    expect(row?.statusExpiresAt?.toISOString()).toBe("2026-09-18T15:00:00.000Z");
  });
});

describe("chatOnlineResponseSchema", () => {
  it("carries the custom message and expiry through instead of silently stripping them from every avatar", () => {
    const parsed = chatOnlineResponseSchema.parse([
      {
        userId: "user-a",
        status: "BUSY",
        statusMessage: "Heads-down until 3pm",
        statusExpiresAt: new Date("2026-09-18T15:00:00.000Z"),
        lastSeenAt: new Date("2026-09-18T09:30:00.000Z"),
        userName: null,
        userImage: null,
      },
    ]);

    expect(parsed[0]?.statusMessage).toBe("Heads-down until 3pm");
    expect(parsed[0]?.statusExpiresAt).toEqual(new Date("2026-09-18T15:00:00.000Z"));
  });

  it("accepts a cleared message and a standing status as null rather than throwing", () => {
    expect(
      chatOnlineResponseSchema.safeParse([
        {
          userId: "user-a",
          status: "ONLINE",
          statusMessage: null,
          statusExpiresAt: null,
          lastSeenAt: new Date(),
          userName: null,
          userImage: null,
        },
      ]).success,
    ).toBe(true);
  });
});

describe("statusSchema — the custom message and duration boundary", () => {
  it("accepts a message and a named duration", () => {
    expect(
      statusSchema.safeParse({
        status: "BUSY",
        statusMessage: "Heads-down until 3pm",
        clearAfter: "today",
      }).success,
    ).toBe(true);
  });

  it("trims the message, so whitespace cannot smuggle in a blank status nobody can clear", () => {
    const parsed = statusSchema.parse({ status: "BUSY", statusMessage: "  hi  " });
    expect(parsed.statusMessage).toBe("hi");
  });

  it("rejects a message past the stored limit rather than truncating it in the database", () => {
    expect(
      statusSchema.safeParse({
        status: "BUSY",
        statusMessage: "x".repeat(PRESENCE_STATUS_MESSAGE_MAX_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects a raw duration in minutes, because the server owns the clock", () => {
    expect(statusSchema.safeParse({ status: "BUSY", clearAfter: 60 }).success).toBe(false);
    expect(statusSchema.safeParse({ status: "BUSY", clearAfter: "3h" }).success).toBe(false);
  });

  it("offers exactly the four durations the picker renders", () => {
    expect(PRESENCE_CLEAR_AFTER_OPTIONS).toEqual(["1h", "today", "week", "never"]);
  });
});
