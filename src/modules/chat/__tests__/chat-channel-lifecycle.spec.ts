import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { CacheService } from "../../../common/cache/cache.service";
import type { AblyService } from "../../realtime/ably.service";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import type { EntityActor } from "../../entity-reference/entity-reference.types";
import { ChatChannelMembersService } from "../chat-channel-members.service";

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
    insert: jest.fn(() => ({ values: jest.fn((v: unknown) => { inserted.push(v); return Promise.resolve(); }) })),
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
  return new ChatChannelMembersService(
    db,
    {} as unknown as CacheService,
    resolver,
    {} as unknown as AblyService,
  );
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
