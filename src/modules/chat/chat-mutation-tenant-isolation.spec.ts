import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../db/drizzle.constants";
import { EntityReferenceService } from "../entity-reference/entity-reference.service";
import { ChatPinsService } from "./chat-pins.service";
import { ChatSavedService } from "./chat-saved.service";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (!isRecord(value) || seen.has(value)) return [];

  seen.add(value);
  const queryChunks = value.queryChunks;
  const nestedValue = value.value;
  return [
    ...(Array.isArray(queryChunks) ? sqlValues(queryChunks, seen) : []),
    ...(Object.hasOwn(value, "value") ? sqlValues(nestedValue, seen) : []),
  ];
}

describe("Chat mutation services — cross-tenant isolation", () => {
  const actor = { orgId: "org-attacker", userId: "user-attacker", isOrgOwner: false };

  it("ChatPinsService binds membership to the actor organization and denies before pin mutation", async () => {
    const db = {
      query: {
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(undefined) },
        chatMessages: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatPinsService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatPinsService);

    await expect(service.pin(27, 91, actor)).rejects.toThrow(ForbiddenException);

    const membershipQuery = db.query.chatChannelMembers.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(membershipQuery?.where)).toContain(actor.orgId);
    expect(db.query.chatMessages.findFirst).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("ChatSavedService binds the target message to the actor organization and denies before save mutation", async () => {
    const db = {
      query: {
        chatMessages: { findFirst: jest.fn().mockResolvedValue(undefined) },
        chatChannelMembers: { findFirst: jest.fn() },
      },
      insert: jest.fn(),
    };
    const module = await Test.createTestingModule({
      providers: [
        ChatSavedService,
        { provide: DRIZZLE, useValue: db },
        { provide: EntityReferenceService, useValue: {} },
      ],
    }).compile();
    const service = module.get(ChatSavedService);

    await expect(service.save(actor, 91)).rejects.toThrow(NotFoundException);

    const messageQuery = db.query.chatMessages.findFirst.mock.calls[0]?.[0];
    expect(sqlValues(messageQuery?.where)).toContain(actor.orgId);
    expect(db.query.chatChannelMembers.findFirst).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
