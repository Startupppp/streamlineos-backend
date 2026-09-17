import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import { ChatChannelMemberState } from "../chat-channel-member-state";
import { ChatChannelListService } from "../chat-channel-list.service";

const ORG = "org-a";
const USER = "user-a";
const TARGET = "user-b";
const MEMBERSHIP = 11;
const TARGET_MEMBERSHIP = 12;
const CHANNEL = 5;

const actor: EntityActor = { orgId: ORG, userId: USER, membershipId: MEMBERSHIP, isOrgOwner: false };

const RESOLVED = {
  status: "resolved" as const,
  card: { type: "project", id: "42", title: "Apollo", subtitle: null, status: null, href: "/" },
};
const UNRESOLVED = { status: "unresolved" as const, reference: { type: "project", id: "42" } };

function entities(verdict: typeof RESOLVED | typeof UNRESOLVED): EntityReferenceService {
  return {
    resolve: jest.fn((_a: EntityActor, refs: unknown[]) => Promise.resolve(refs.map(() => verdict))),
  } as unknown as EntityReferenceService;
}

interface Channel {
  id: number;
  type: string;
  isPrivate: boolean;
  entityType: string | null;
  entityId: string | null;
}

function build(
  channel: Channel | undefined,
  options: {
    member?: { role: string } | null;
    memberships?: { id: number; isOwner: boolean }[];
  } = {},
) {
  const member = "member" in options ? options.member : { role: "MEMBER" };
  const memberships = options.memberships ?? [
    { id: MEMBERSHIP, isOwner: false },
    { id: TARGET_MEMBERSHIP, isOwner: false },
  ];
  let membershipCall = 0;
  const inserted: unknown[] = [];
  const deleted: unknown[] = [];
  const db = {
    query: {
      chatChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(member) },
      organizationMembers: {
        findFirst: jest.fn(() => Promise.resolve(memberships[membershipCall++])),
      },
    },
    insert: jest.fn(() => ({
      values: jest.fn((v: unknown) => {
        inserted.push(v);
        const settled = Promise.resolve();
        return Object.assign(settled, { onConflictDoNothing: () => settled });
      }),
    })),
    delete: jest.fn(() => ({ where: jest.fn((w: unknown) => { deleted.push(w); return Promise.resolve(); }) })),
    select: jest.fn(),
    transaction: jest.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        delete: jest.fn(() => ({ where: jest.fn((w: unknown) => { deleted.push(w); return Promise.resolve(); }) })),
        insert: jest.fn(() => ({ values: jest.fn(() => Promise.resolve()) })),
        execute: jest.fn().mockResolvedValue([]),
      }),
    ),
  } as unknown as Db;
  return { db, inserted, deleted };
}

function service(db: Db, resolver: EntityReferenceService) {
  return new ChatChannelMembersImplementation(db, resolver);
}

describe("joinOpenChannel — what 'open' means", () => {
  it("ALLOW: a PUBLIC channel is joinable by any active member", async () => {
    const { db, inserted } = build(
      { id: CHANNEL, type: "PUBLIC", isPrivate: false, entityType: null, entityId: null },
      { member: null },
    );
    await expect(service(db, entities(RESOLVED)).joinOpenChannel(CHANNEL, actor)).resolves.toEqual({
      ok: true,
    });
    expect(inserted).toHaveLength(1);
  });

  it("DENY: a PRIVATE channel with no record behind it is 404 — invite-only means invite-only", async () => {
    const { db, inserted } = build(
      { id: CHANNEL, type: "PRIVATE", isPrivate: true, entityType: null, entityId: null },
      { member: null },
    );
    await expect(
      service(db, entities(RESOLVED)).joinOpenChannel(CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inserted).toHaveLength(0);
  });

  it("DENY: a record channel is 404 when the record does not resolve for the caller", async () => {
    const { db, inserted } = build(
      { id: CHANNEL, type: "GROUP", isPrivate: true, entityType: "project", entityId: "42" },
      { member: null },
    );
    await expect(
      service(db, entities(UNRESOLVED)).joinOpenChannel(CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(inserted).toHaveLength(0);
  });

  it("ALLOW: a record channel is joinable by whoever can read the record", async () => {
    const { db, inserted } = build(
      { id: CHANNEL, type: "GROUP", isPrivate: true, entityType: "project", entityId: "42" },
      { member: null },
    );
    await expect(service(db, entities(RESOLVED)).joinOpenChannel(CHANNEL, actor)).resolves.toEqual({
      ok: true,
    });
    expect(inserted).toHaveLength(1);
  });

  it("ALLOW: re-joining is idempotent and writes no second membership row", async () => {
    const { db, inserted } = build(
      { id: CHANNEL, type: "PUBLIC", isPrivate: false, entityType: null, entityId: null },
      { member: { role: "MEMBER" } },
    );
    await expect(service(db, entities(RESOLVED)).joinOpenChannel(CHANNEL, actor)).resolves.toEqual({
      ok: true,
    });
    expect(inserted).toHaveLength(0);
  });

  it("DENY: an archived channel is 404 — the lookup binds is_archived = false", async () => {
    const { db } = build(undefined, { member: null });
    await expect(
      service(db, entities(RESOLVED)).joinOpenChannel(CHANNEL, actor),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("removeMember — a plain member may remove only themselves", () => {
  const channel: Channel = {
    id: CHANNEL,
    type: "PRIVATE",
    isPrivate: true,
    entityType: null,
    entityId: null,
  };

  it("DENY: a MEMBER cannot remove someone else", async () => {
    const { db, deleted } = build(channel, { member: { role: "MEMBER" } });
    await expect(
      service(db, entities(RESOLVED)).removeMember(CHANNEL, TARGET, USER, ORG),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(deleted).toHaveLength(0);
  });

  it("ALLOW: a MEMBER may remove themselves", async () => {
    const { db, deleted } = build(channel, { member: { role: "MEMBER" } });
    await expect(
      service(db, entities(RESOLVED)).removeMember(CHANNEL, USER, USER, ORG),
    ).resolves.toEqual({ ok: true });
    expect(deleted).toHaveLength(1);
  });

  it("ALLOW: an ADMIN may remove someone else", async () => {
    const { db, deleted } = build(channel, { member: { role: "ADMIN" } });
    await expect(
      service(db, entities(RESOLVED)).removeMember(CHANNEL, TARGET, USER, ORG),
    ).resolves.toEqual({ ok: true });
    expect(deleted).toHaveLength(1);
  });

  it("DENY: a non-member of a PRIVATE channel is 404, not 403 — removal is not an existence oracle", async () => {
    const { db, deleted } = build(channel, { member: null });
    await expect(
      service(db, entities(RESOLVED)).removeMember(CHANNEL, TARGET, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(deleted).toHaveLength(0);
  });
});

describe("leaveChannel — a non-member cannot leave what they are not in", () => {
  it("DENY: a non-member of a PRIVATE channel is 404", async () => {
    const { db, deleted } = build(
      { id: CHANNEL, type: "PRIVATE", isPrivate: true, entityType: null, entityId: null },
      { member: null },
    );
    await expect(
      service(db, entities(RESOLVED)).leaveChannel(CHANNEL, USER, ORG),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(deleted).toHaveLength(0);
  });

  it("ALLOW: a member leaves and the membership row is deleted", async () => {
    const { db, deleted } = build(
      { id: CHANNEL, type: "PRIVATE", isPrivate: true, entityType: null, entityId: null },
      { member: { role: "MEMBER" } },
    );
    await expect(service(db, entities(RESOLVED)).leaveChannel(CHANNEL, USER, ORG)).resolves.toEqual(
      { ok: true },
    );
    expect(deleted).toHaveLength(1);
  });
});

const dialect = new PgDialect();

interface MemberRow {
  channelId: number;
  membershipId: number;
  role: string;
  archivedAt: Date | null;
}

function equalityBindings(where: SQL): Map<string, unknown> {
  const { sql: text, params } = dialect.sqlToQuery(where);
  const bindings = new Map<string, unknown>();
  const pattern = /"(\w+)"\."(\w+)"\s*=\s*\$(\d+)/gi;
  let match = pattern.exec(text);
  while (match !== null) {
    bindings.set(`${match[1]}.${match[2]}`, params[Number(match[3]) - 1]);
    match = pattern.exec(text);
  }
  return bindings;
}

function isKeysetPage(where: SQL): boolean {
  const { sql: text } = dialect.sqlToQuery(where);
  return (
    /"chat_channel_members"\."archived_at"/i.test(text) &&
    /"chat_channel_members"\."membership_id"\s*=\s*\$/i.test(text)
  );
}

function archiveSideOf(where: SQL): "archived" | "active" {
  const { sql: text } = dialect.sqlToQuery(where);
  if (/"chat_channel_members"\."archived_at"\s+is\s+not\s+null/i.test(text)) return "archived";
  if (/"chat_channel_members"\."archived_at"\s+is\s+null/i.test(text)) return "active";
  throw new Error(`the channel list does not constrain archived_at: ${text}`);
}

const LIST_CHANNEL_ROW = {
  id: CHANNEL,
  name: "Launch",
  type: "PRIVATE",
  avatarUrl: null,
  isArchived: false,
  entityType: null,
  entityId: null,
};

interface RoundTrip {
  state: ChatChannelMemberState;
  list: ChatChannelListService;
  store: MemberRow[];
  deleteCalls: () => number;
}

function buildRoundTrip(): RoundTrip {
  const store: MemberRow[] = [
    { channelId: CHANNEL, membershipId: MEMBERSHIP, role: "MEMBER", archivedAt: null },
    { channelId: CHANNEL, membershipId: TARGET_MEMBERSHIP, role: "ADMIN", archivedAt: null },
  ];
  const deleteMock = jest.fn();

  const pageRows = (where: SQL) => {
    const row = store.find((r) => r.channelId === CHANNEL && r.membershipId === MEMBERSHIP);
    if (!row) return [];
    const wanted = archiveSideOf(where);
    const isArchived = row.archivedAt !== null;
    if (wanted === "archived" && !isArchived) return [];
    if (wanted === "active" && isArchived) return [];
    return [{ id: CHANNEL, lastMessageAt: null }];
  };

  const makeChain = () => {
    let where: SQL | undefined;
    const chain: Record<string, unknown> = {};
    for (const method of ["from", "innerJoin", "innerJoinLateral", "leftJoin", "groupBy", "having", "orderBy", "limit", "as"])
      chain[method] = jest.fn(() => chain);
    chain.where = jest.fn((predicate: SQL) => {
      where = predicate;
      return chain;
    });
    chain.then = (resolve: (value: unknown[]) => unknown) =>
      resolve(where !== undefined && isKeysetPage(where) ? pageRows(where) : []);
    return chain;
  };

  const db = {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL, isPrivate: true, entityType: null, entityId: null }),
        findMany: jest.fn().mockResolvedValue([LIST_CHANNEL_ROW]),
      },
      organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP, isOwner: false }) },
      chatChannelMembers: {
        findFirst: jest.fn(() => {
          const row = store.find((r) => r.channelId === CHANNEL && r.membershipId === MEMBERSHIP);
          return Promise.resolve(row ? { role: row.role } : undefined);
        }),
      },
    },
    select: jest.fn(() => makeChain()),
    update: jest.fn(() => ({
      set: (values: Partial<MemberRow>) => ({
        where: (predicate: SQL) => {
          const bindings = equalityBindings(predicate);
          if (!bindings.has("chat_channel_members.org_id"))
            throw new Error("a member-state write must be tenant-scoped");
          const matches = (column: string, value: unknown) =>
            !bindings.has(column) || bindings.get(column) === value;
          for (const row of store) {
            if (bindings.get("chat_channel_members.org_id") !== ORG) continue;
            if (!matches("chat_channel_members.channel_id", row.channelId)) continue;
            if (!matches("chat_channel_members.membership_id", row.membershipId)) continue;
            Object.assign(row, values);
          }
          return Promise.resolve(undefined);
        },
      }),
    })),
    delete: deleteMock,
  } as unknown as Db;

  const resolver = entities(RESOLVED);
  return {
    state: new ChatChannelMemberState(db),
    list: new ChatChannelListService(db, resolver),
    store,
    deleteCalls: () => deleteMock.mock.calls.length,
  };
}

async function listedIds(list: ChatChannelListService, archived: boolean): Promise<number[]> {
  const page = archived ? await list.getArchivedChannels(actor) : await list.getMyChannels(actor);
  return page.channels.map((channel) => channel.id);
}

describe("archive then unarchive returns the channel to the list it came from", () => {
  it("CONTROL: an unarchived channel is in my channels and absent from archived", async () => {
    const harness = buildRoundTrip();

    expect(await listedIds(harness.list, false)).toEqual([CHANNEL]);
    expect(await listedIds(harness.list, true)).toEqual([]);
  });

  it("archiving moves it out of my channels and into archived", async () => {
    const harness = buildRoundTrip();

    await expect(harness.state.archiveChannel(CHANNEL, USER, ORG)).resolves.toEqual({ ok: true });

    expect(await listedIds(harness.list, false)).toEqual([]);
    expect(await listedIds(harness.list, true)).toEqual([CHANNEL]);
  });

  it("unarchiving puts it back in my channels exactly once and clears it from archived", async () => {
    const harness = buildRoundTrip();

    await harness.state.archiveChannel(CHANNEL, USER, ORG);
    await expect(harness.state.unarchiveChannel(CHANNEL, USER, ORG)).resolves.toEqual({ ok: true });

    expect(await listedIds(harness.list, false)).toEqual([CHANNEL]);
    expect(await listedIds(harness.list, true)).toEqual([]);
  });

  it("the round trip loses no membership: the same two rows with the same roles survive it", async () => {
    const harness = buildRoundTrip();

    await harness.state.archiveChannel(CHANNEL, USER, ORG);
    await harness.state.unarchiveChannel(CHANNEL, USER, ORG);

    expect(harness.store).toHaveLength(2);
    expect(harness.store.map((row) => [row.membershipId, row.role, row.archivedAt])).toEqual([
      [MEMBERSHIP, "MEMBER", null],
      [TARGET_MEMBERSHIP, "ADMIN", null],
    ]);
    expect(harness.deleteCalls()).toBe(0);
  });

  it("archiving is the caller's own view: the other member's row is not stamped", async () => {
    const harness = buildRoundTrip();

    await harness.state.archiveChannel(CHANNEL, USER, ORG);

    const mine = harness.store.find((row) => row.membershipId === MEMBERSHIP);
    const theirs = harness.store.find((row) => row.membershipId === TARGET_MEMBERSHIP);
    expect(mine?.archivedAt).toBeInstanceOf(Date);
    expect(theirs?.archivedAt).toBeNull();
  });

  it("unarchiving clears archived_at rather than stamping a newer date", async () => {
    const harness = buildRoundTrip();

    await harness.state.archiveChannel(CHANNEL, USER, ORG);
    await harness.state.unarchiveChannel(CHANNEL, USER, ORG);

    expect(harness.store.find((row) => row.membershipId === MEMBERSHIP)?.archivedAt).toBeNull();
  });

  it("DENY: a non-member cannot archive, so the lists cannot be moved by an outsider", async () => {
    const harness = buildRoundTrip();
    harness.store.splice(0, 1);

    await expect(harness.state.archiveChannel(CHANNEL, USER, ORG)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
