import type { Db } from "../../db/drizzle.module";
import { UnifiedInboxService } from "./unified-inbox.service";
import type { AccessService } from "../access/access.service";
import type { MailService } from "../mail/mail.service";
import type { BroadcastsService } from "./broadcasts.service";
import type { BuildApprovalsInboxService } from "../build/approvals/build-approvals-inbox.service";
import type { UnifiedInboxQuery } from "./dto/unified-inbox.schemas";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("UnifiedInboxService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const VICTIM_USER = "user-victim";
  const CALLER_USER = "user-caller";

  function makeNotifDb(): { db: Db; where: jest.Mock } {
    const where = jest.fn();
    const limit = jest.fn().mockResolvedValue([]);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const leftJoin = jest.fn();
    const from = jest.fn();
    const builder = { from, leftJoin, where, orderBy, limit };
    from.mockReturnValue(builder);
    leftJoin.mockReturnValue({ where });
    where.mockReturnValue({ orderBy });

    const db = {
      select: jest.fn().mockReturnValue(builder),
    } as unknown as Db;
    return { db, where };
  }

  function makeAccess(): AccessService {
    return { holds: jest.fn().mockResolvedValue(false) } as unknown as AccessService;
  }

  function makeMail(): MailService {
    return { listMessages: jest.fn() } as unknown as MailService;
  }

  function makeBroadcasts(): BroadcastsService {
    return { listInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BroadcastsService;
  }

  function makeBuildApprovals(): BuildApprovalsInboxService {
    return { getInboxPage: jest.fn().mockResolvedValue([]) } as unknown as BuildApprovalsInboxService;
  }

  const query: UnifiedInboxQuery = { kinds: ["notification"], limit: 25, unreadOnly: false };

  it("scopes notification query to the requesting org — cross-tenant isolation", async () => {
    const { db, where } = makeNotifDb();
    const svc = new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals());

    const result = await svc.list(ATTACKER_ORG, CALLER_USER, query, { orgId: ATTACKER_ORG, userId: CALLER_USER } as never);

    expect(result.items).toHaveLength(0);
    expect(where).toHaveBeenCalled();
    expect(sqlValues(where.mock.calls[0]?.[0])).toContain(ATTACKER_ORG);
  });

  it("does not return notifications addressed to a different userId — user isolation", async () => {
    const { db, where } = makeNotifDb();
    const svc = new UnifiedInboxService(db, makeAccess(), makeMail(), makeBroadcasts(), makeBuildApprovals());

    const result = await svc.list(ATTACKER_ORG, CALLER_USER, query, { orgId: ATTACKER_ORG, userId: CALLER_USER } as never);

    expect(result.items).toHaveLength(0);
    const predicateValues = sqlValues(where.mock.calls[0]?.[0]);
    expect(predicateValues).toContain(CALLER_USER);
    expect(predicateValues).not.toContain(VICTIM_USER);
  });
});
