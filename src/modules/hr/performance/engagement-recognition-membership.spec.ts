import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { EngagementBadgesService } from "./engagement-badges.service";
import { EngagementService } from "./engagement.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || ["string", "number", "boolean"].includes(typeof value)) return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

function buildDb() {
  const recognitionFindFirst = jest.fn().mockResolvedValue(null);
  const recipientFindFirst = jest.fn().mockResolvedValue({ id: 22 });
  const returning = jest.fn().mockResolvedValue([{ id: 7 }]);
  const recognitionValues = jest.fn().mockReturnValue({ returning });
  const auditValues = jest.fn().mockResolvedValue(undefined);
  const insert = jest
    .fn()
    .mockReturnValueOnce({ values: recognitionValues })
    .mockReturnValueOnce({ values: auditValues });

  return {
    db: {
      insert,
      query: {
        recognitions: { findFirst: recognitionFindFirst },
        organizationMembers: { findFirst: recipientFindFirst },
      },
    } as unknown as Db,
    recognitionFindFirst,
    recipientFindFirst,
    recognitionValues,
  };
}

const actor: CurrentUserContext = {
  userId: "sender-user",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(11, false),
};

describe("EngagementService recognition membership identity", () => {
  it("keys the recipient, sender duplicate check, and write by organization memberships while retaining user display ids", async () => {
    const { db, recognitionFindFirst, recipientFindFirst, recognitionValues } = buildDb();
    const badges = { grantKudosPoints: jest.fn().mockResolvedValue(undefined) } as unknown as EngagementBadgesService;
    const service = new EngagementService(db, badges);

    await service.createRecognition(actor, {
      toUserId: "recipient-user",
      message: "Thank you for your thoughtful help today.",
      category: "KUDOS",
    });

    expect(recipientFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.anything() }));
    const duplicateCall = recognitionFindFirst.mock.calls[0]?.[0] as { where: unknown };
    expect(sqlValues(duplicateCall.where)).toEqual(expect.arrayContaining(["org-1", 11, 22]));
    expect(sqlValues(duplicateCall.where)).not.toEqual(expect.arrayContaining(["sender-user", "recipient-user"]));
    expect(recognitionValues).toHaveBeenCalledWith(expect.objectContaining({
      fromUserId: "sender-user",
      fromMembershipId: 11,
      toUserId: "recipient-user",
      toMembershipId: 22,
    }));
  });
});
