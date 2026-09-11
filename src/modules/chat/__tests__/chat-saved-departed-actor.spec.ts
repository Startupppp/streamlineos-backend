import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { EntityReferenceService } from "../../entity-reference/entity-reference.service";
import { ChatSavedService } from "../chat-saved.service";
import { getTableConfig } from "drizzle-orm/pg-core";
import { chatSavedMessages } from "../../../db/schema/chat/chat-message-tables";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v !== "object") return [v];
  if (Array.isArray(v)) return v.flatMap((x) => sqlValues(x, seen));
  if (seen.has(v as object)) return [];
  seen.add(v as object);
  const r = v as Record<string, unknown>;
  return [
    ...(Array.isArray(r.queryChunks) ? sqlValues(r.queryChunks, seen) : []),
    ...("value" in r ? sqlValues(r.value, seen) : []),
  ];
}

const ORG = "org-1";
const MEMBERSHIP = 7;

function makeDb(overrides: Partial<{ savedRows: unknown[]; message: unknown; channelMember: unknown }> = {}) {
  const {
    savedRows = [],
    message = { id: 42, channelId: 1, orgId: ORG },
    channelMember = { id: MEMBERSHIP },
  } = overrides;
  return {
    query: {
      chatSavedMessages: { findMany: jest.fn().mockResolvedValue(savedRows), findFirst: jest.fn().mockResolvedValue(null) },
      chatMessages: { findFirst: jest.fn().mockResolvedValue(message) },
      chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(channelMember) },
    },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ messageId: 42 }]) }),
  };
}

describe("ChatSavedService — departed-actor display", () => {
  const entities = { withResolvedReferences: jest.fn().mockImplementation((_actor: unknown, msgs: unknown[]) => Promise.resolve(msgs)) };

  async function build(db: ReturnType<typeof makeDb>) {
    const mod = await Test.createTestingModule({
      providers: [
        ChatSavedService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: entities },
      ],
    }).compile();
    return mod.get(ChatSavedService);
  }

  beforeEach(() => jest.clearAllMocks());

  it("list() returns empty when actor.membershipId is null (departed-member guard)", async () => {
    const db = makeDb();
    const service = await build(db);
    const result = await service.list({ orgId: ORG, userId: "u1", isOrgOwner: false, membershipId: undefined });
    expect(result.items).toHaveLength(0);
    expect(db.query.chatSavedMessages.findMany).not.toHaveBeenCalled();
  });

  it("list() queries by membershipId — does not touch user_id column", async () => {
    const db = makeDb({ savedRows: [] });
    const service = await build(db);
    await service.list({ orgId: ORG, userId: "u1", isOrgOwner: false, membershipId: MEMBERSHIP });
    const call = db.query.chatSavedMessages.findMany.mock.calls[0]?.[0];
    const values = sqlValues(call?.where);
    expect(values).toContain(MEMBERSHIP);
    expect(values).not.toContain("u1");
  });

  it("save() throws ForbiddenException when actor.membershipId is null — no null rows ever inserted", async () => {
    const db = makeDb();
    const service = await build(db);
    await expect(
      service.save({ orgId: ORG, userId: "u1", isOrgOwner: false, membershipId: undefined }, 42),
    ).rejects.toThrow(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("save() insert values contain membershipId — user_id is not in the inserted payload", async () => {
    const db = makeDb();
    const service = await build(db);
    await service.save({ orgId: ORG, userId: "u1", isOrgOwner: false, membershipId: MEMBERSHIP }, 42);
    const inserted = db.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(inserted).toMatchObject({ orgId: ORG, membershipId: MEMBERSHIP, messageId: 42 });
    expect(inserted).not.toHaveProperty("userId");
  });

  it("unsave() deletes by membershipId — does not reference user_id", async () => {
    const db = makeDb();
    const service = await build(db);
    await service.unsave({ orgId: ORG, userId: "u1", isOrgOwner: false, membershipId: MEMBERSHIP }, 42);
    const whereArgs = db.where.mock.calls[0];
    const values = whereArgs ? sqlValues(whereArgs) : [];
    expect(values).toContain(MEMBERSHIP);
    expect(values).not.toContain("u1");
  });

  it("departed-member saved items do not survive departure — the membership FK cascades", () => {
    // This asserted expect(true).toBe(true) under a title claiming a design
    // proof. The claim is checkable against the schema the migration builds.
    const { foreignKeys } = getTableConfig(chatSavedMessages);
    const membershipFk = foreignKeys.find(
      (fk) => fk.getName() === "fk_chat_saved_messages_org_membership",
    );
    expect(membershipFk).toBeDefined();
    expect(membershipFk?.onDelete).toBe("cascade");
    const reference = membershipFk?.reference();
    expect(reference?.foreignColumns.map((c) => c.name)).toEqual(["org_id", "id"]);
    expect(reference?.columns.map((c) => c.name)).toEqual(["org_id", "membership_id"]);
  });
});
