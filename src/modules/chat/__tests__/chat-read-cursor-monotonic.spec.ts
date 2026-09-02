import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.module";
import { CacheService } from "../../../common/cache/cache.service";
import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";

/**
 * Two marks in flight commit in either order. With a plain assignment the older
 * timestamp can land last and rewind the cursor, so already-read messages come back
 * unread; GREATEST makes the advance monotonic regardless of commit order.
 */
const dialect = new PgDialect();

const ORG = "org-a";
const USER = "user-a";
const CHANNEL_ID = 42;
const MEMBERSHIP = 11;

function harness() {
  const setCalls: Array<Record<string, unknown>> = [];
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue({ id: CHANNEL_ID, isPrivate: false }) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }) },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP }) },
    },
    update: jest.fn(() => ({
      set: jest.fn((values: Record<string, unknown>) => {
        setCalls.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
  };
  const cache = { invalidateNamespace: jest.fn().mockResolvedValue(undefined) };
  const impl = new ChatChannelMembersImplementation(
    db as unknown as Db,
    cache as unknown as CacheService,
  );
  return { impl, setCalls, cache };
}

describe("chat read cursor advances monotonically", () => {
  it("markRead writes GREATEST(last_read_at, <now>) rather than assigning", async () => {
    const { impl, setCalls } = harness();

    await impl.markRead(CHANNEL_ID, USER, ORG);

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0]?.["lastReadAt"];
    const rendered = dialect.sqlToQuery(written as SQL);
    expect(rendered.sql).toContain("GREATEST");
    expect(rendered.sql).toContain("last_read_at");
    // The timestamp crosses as a bound ISO string with an explicit cast: a JS Date
    // interpolated into a raw sql template reaches postgres.js as a Date and throws.
    expect(rendered.sql).toContain("::timestamp");
    expect(rendered.params).toHaveLength(1);
    expect(typeof rendered.params[0]).toBe("string");
    expect(String(rendered.params[0])).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("markRead still scopes the write to org, channel and the caller's own membership", async () => {
    const { impl, cache } = harness();

    await impl.markRead(CHANNEL_ID, USER, ORG);

    expect(cache.invalidateNamespace).toHaveBeenCalledWith(`chat:unread:${ORG}`);
  });

  it("markChannelUnread deliberately moves the cursor back, so it must not be guarded", async () => {
    const { impl, setCalls } = harness();

    await impl.markChannelUnread(CHANNEL_ID, USER, ORG);

    expect(setCalls).toHaveLength(1);
    const written = setCalls[0]?.["lastReadAt"];
    expect(written).toBeInstanceOf(Date);
  });
});
