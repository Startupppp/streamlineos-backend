import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { loadChannelMemberPreview } from "../chat-channel-member-preview";
import type { Db } from "../../../db/drizzle.module";

/**
 * The member preview must not filter on `chat_channel_members.archived_at`.
 *
 * `archived_at` is the caller's own inbox state — archiving a conversation sets it on
 * your member row and leaves you a member. While the preview filtered it out, every
 * row of `GET /chat/channels/archived` came back missing the reader's own member row,
 * so a self-DM (where the reader is the only member) rendered "Unknown" with
 * `memberCount: 0`, and every archived row's favourite, mute, role and notification
 * controls — all of which live on that row — read defaults (CHAT-004).
 *
 * The assertion is on the emitted SQL rather than on rows, because the defect was a
 * predicate: a fake that returns rows cannot tell a missing predicate from a missing
 * row.
 */

const dialect = new PgDialect();

function captureRankedWhere(): { db: Db; read: () => string } {
  let captured = "";
  const rankedSubquery = { memberRank: sql`member_rank` };

  const firstSelect = {
    from: () => ({
      innerJoin: () => ({
        leftJoin: () => ({
          where: (predicate: SQL) => {
            captured = dialect.sqlToQuery(predicate).sql;
            return { as: () => rankedSubquery };
          },
        }),
      }),
    }),
  };

  const secondSelect = {
    from: () => ({ where: () => Promise.resolve([]) }),
  };

  const select = jest.fn((projection?: unknown) =>
    projection === undefined ? secondSelect : firstSelect,
  );

  return { db: { select } as unknown as Db, read: () => captured };
}

describe("loadChannelMemberPreview predicate", () => {
  it("does not filter the roster by the reader's archived_at", async () => {
    const { db, read } = captureRankedWhere();

    await loadChannelMemberPreview(db, "org-1", [5], 10);

    expect(read()).not.toMatch(/archived_at/);
  });

  it("still scopes the roster to the org and the requested channels", async () => {
    const { db, read } = captureRankedWhere();

    await loadChannelMemberPreview(db, "org-1", [5], 10);

    expect(read()).toMatch(/org_id/);
    expect(read()).toMatch(/channel_id/);
  });
});
