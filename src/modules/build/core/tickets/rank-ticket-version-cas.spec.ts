import { humanSessionPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { AccessService } from "../../../access/access.service";
import type { CacheService } from "../../../../common/cache/cache.service";
import type { Db } from "../../../../db/drizzle.types";
import { rankTicket } from "./projects-tickets-rank-utils";
import { TicketVersionConflictException } from "./ticket-version-conflict.exception";
import { rankTicketSchema } from "../dto/projects.schemas";

const actor: CurrentUserContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "owner",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
};

const access = {
  scopeFor: jest.fn().mockResolvedValue("all"),
} as unknown as AccessService;

const cache = {
  invalidateNamespace: jest.fn().mockResolvedValue(undefined),
  del: jest.fn().mockResolvedValue(undefined),
} as unknown as CacheService;

function makeDb(ticketVersion: number, updateReturning: unknown[]) {
  const targetRows = [
    {
      id: 7,
      status: "TODO",
      rank: "1000",
      version: ticketVersion,
      assigneeMembershipId: null,
      dueDate: null,
      priority: "MEDIUM",
      points: 1,
      epicId: null,
      cycleId: null,
      allowed: true,
    },
  ];

  let selectCallCount = 0;

  const makeSelectChain = (rows: unknown[]) => ({
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    then: (resolve: (value: unknown[]) => unknown) =>
      Promise.resolve(rows).then(resolve),
  });

  const updateMock = jest.fn().mockImplementation(() => ({
    set: jest.fn().mockImplementation(() => ({
      where: jest.fn().mockImplementation(() => ({
        returning: jest.fn().mockResolvedValue(updateReturning),
      })),
    })),
  }));

  const db = {
    select: jest.fn().mockImplementation(() => {
      selectCallCount++;
      return selectCallCount === 1
        ? makeSelectChain(targetRows)
        : makeSelectChain([]);
    }),
    update: updateMock,
    execute: jest
      .fn()
      .mockResolvedValue([{ rank: "2000", valid: true }]),
    query: {
      projects: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ managerMembershipId: 1 }),
      },
    },
    transaction: jest.fn(),
  };
  db.transaction.mockImplementation(
    async (cb: (tx: typeof db) => Promise<unknown>) => cb(db),
  );
  return { db, updateMock };
}

describe("rankTicketSchema — optional version field declared for stage-one CAS", () => {
  it("accepts a body without version — omitting the token must not break existing callers", () => {
    const result = rankTicketSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("accepts a body that carries a valid positive integer version", () => {
    const result = rankTicketSchema.safeParse({ version: 5 });
    expect(result.success).toBe(true);
  });

  it("rejects a non-integer version — the field type is enforced even when optional", () => {
    const result = rankTicketSchema.safeParse({ version: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects a zero version — version must be positive", () => {
    const result = rankTicketSchema.safeParse({ version: 0 });
    expect(result.success).toBe(false);
  });
});

describe("rankTicket — version CAS (stage-one: accept-and-warn, token not required)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (access.scopeFor as jest.Mock).mockResolvedValue("all");
    (cache.invalidateNamespace as jest.Mock).mockResolvedValue(undefined);
  });

  it("throws TicketVersionConflictException carrying the current version when a stale token is supplied (i — stale token → 409)", async () => {
    const { db } = makeDb(5, []);
    const error = await rankTicket(
      db as unknown as Db,
      cache,
      access,
      actor,
      1,
      7,
      { version: 3 },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketVersionConflictException);
    expect(
      (error as TicketVersionConflictException).getResponse(),
    ).toMatchObject({ code: "PROJECTS_TICKET_CONFLICT", details: { currentVersion: 5 } });
  });

  it("makes no DB write when a stale token is detected — the update must not be called before the conflict is raised (BE-141 stale-negative pair)", async () => {
    const { db, updateMock } = makeDb(5, []);
    await rankTicket(
      db as unknown as Db,
      cache,
      access,
      actor,
      1,
      7,
      { version: 3 },
    ).catch(() => undefined);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("resolves without error when the supplied version matches the stored version (ii — correct token → 200)", async () => {
    const { db } = makeDb(5, [{ id: 7, rank: "2000", status: "TODO", version: 6 }]);
    await expect(
      rankTicket(db as unknown as Db, cache, access, actor, 1, 7, { version: 5 }),
    ).resolves.toBeDefined();
  });

  it("resolves without error when no version is supplied — omitting the token must never reject the request (iii — token omitted → success, breaking-change guard)", async () => {
    const { db } = makeDb(5, [{ id: 7, rank: "2000", status: "TODO", version: 6 }]);
    await expect(
      rankTicket(db as unknown as Db, cache, access, actor, 1, 7, {}),
    ).resolves.toBeDefined();
  });
});
