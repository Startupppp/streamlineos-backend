import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { humanSessionPrincipal, systemJobPrincipal } from "../../../../common/auth/principal";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { Db } from "../../../../db/drizzle.types";
import type { AccessService } from "../../../access/access.service";
import {
  assertProjectAccess,
  assertProjectAggregateAccess,
  assertProjectInOrg,
  assertTicketReadAccess,
  authorizeTicketMutation,
  readMutationTickets,
  resolveProjectAccess,
} from "./project-access";

const MEMBER_MID = 42;
const PROJECT_ID = 10;
const TICKET_ID = 99;
const ORG_ID = "org-1";
const USER_ID = "user-1";

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    orgId: ORG_ID,
    userId: USER_ID,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "sess-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBER_MID, false),
    ...overrides,
  };
}

function makeDb(opts: {
  projectRow?: object;
  selectRows?: object[];
  orderByForRows?: object[];
} = {}): Db {
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(),
    innerJoin: jest.fn(),
    where: jest.fn(),
    limit: jest.fn().mockResolvedValue(opts.selectRows ?? []),
    orderBy: jest.fn(),
    for: jest.fn().mockResolvedValue(opts.orderByForRows ?? []),
  };
  chain["from"]!.mockReturnValue(chain);
  chain["innerJoin"]!.mockReturnValue(chain);
  chain["where"]!.mockReturnValue(chain);
  chain["orderBy"]!.mockReturnValue(chain);
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(opts.projectRow) },
      tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue(chain),
    execute: jest.fn().mockResolvedValue(undefined),
  } as unknown as Db;
}

function makeAccess(opts: {
  permsMap?: Map<string, string>;
  scope?: string;
} = {}): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(opts.permsMap ?? new Map()),
    scopeFor: jest.fn().mockResolvedValue(opts.scope ?? "all"),
    holds: jest.fn().mockResolvedValue(false),
  } as unknown as AccessService;
}

describe("assertProjectInOrg", () => {
  it("resolves when project belongs to the tenant", async () => {
    const db = makeDb({ projectRow: { id: PROJECT_ID } });
    await expect(assertProjectInOrg(db, ORG_ID, PROJECT_ID)).resolves.toBeUndefined();
  });

  it("throws 404 when project is absent from the tenant", async () => {
    const db = makeDb({ projectRow: undefined });
    await expect(assertProjectInOrg(db, ORG_ID, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("throws 404 not 403 for cross-tenant miss (conceals existence)", async () => {
    const db = makeDb({ projectRow: undefined });
    const err = await assertProjectInOrg(db, "foreign-org", PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("resolveProjectAccess — org owner", () => {
  it("grants access without a permission lookup when actor is org owner", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: null } });
    const access = makeAccess();
    const actor = makeActor({ isOrgOwner: true, principal: humanSessionPrincipal(MEMBER_MID, true) });
    const result = await resolveProjectAccess(db, access, actor, PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("OWNER");
    expect(access.resolveUserPermissions).not.toHaveBeenCalled();
  });

  it("throws 404 even for org owner when project is in a foreign tenant", async () => {
    const db = makeDb({ projectRow: undefined });
    const access = makeAccess();
    const actor = makeActor({ isOrgOwner: true, principal: humanSessionPrincipal(MEMBER_MID, true) });
    await expect(resolveProjectAccess(db, access, actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("resolveProjectAccess — permission holder", () => {
  it("grants access to a user holding build:manage", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: null } });
    const access = makeAccess({ permsMap: new Map([["build:manage", "all"]]) });
    const result = await resolveProjectAccess(db, access, makeActor(), PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("OWNER");
  });

  it("returns hasAccess false for a same-tenant user without any grant", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: 999 }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map() });
    const result = await resolveProjectAccess(db, access, makeActor(), PROJECT_ID);
    expect(result.hasAccess).toBe(false);
    expect(result.role).toBeNull();
  });
});

describe("resolveProjectAccess — project manager", () => {
  it("grants MANAGER access to the named project manager", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: MEMBER_MID }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map() });
    const result = await resolveProjectAccess(db, access, makeActor(), PROJECT_ID);
    expect(result.hasAccess).toBe(true);
    expect(result.role).toBe("MANAGER");
  });
});

describe("assertProjectAccess", () => {
  it("resolves for an authorized project member", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: MEMBER_MID }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map() });
    await expect(assertProjectAccess(db, access, makeActor(), PROJECT_ID)).resolves.toBeUndefined();
  });

  it("throws 403 for an in-tenant non-member (does not conceal project existence)", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: 999 }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map() });
    const err = await assertProjectAccess(db, access, makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 for a cross-tenant project (conceals existence)", async () => {
    const db = makeDb({ projectRow: undefined });
    const err = await assertProjectAccess(db, makeAccess(), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertProjectAggregateAccess — system-job path", () => {
  it("allows build.daily-snapshots when project is in tenant", async () => {
    const db = makeDb({ projectRow: { id: PROJECT_ID } });
    const access = makeAccess({ scope: "all" });
    const actor = makeActor({ principal: systemJobPrincipal("build.daily-snapshots") });
    await expect(assertProjectAggregateAccess(db, access, actor, PROJECT_ID)).resolves.toBeUndefined();
  });

  it("refuses integrations.git.webhook whose ceiling excludes build:manage", async () => {
    const db = makeDb({ projectRow: { id: PROJECT_ID } });
    const access = makeAccess({ scope: "all" });
    const actor = makeActor({ principal: systemJobPrincipal("integrations.git.webhook") });
    await expect(assertProjectAggregateAccess(db, access, actor, PROJECT_ID)).rejects.toThrow(ForbiddenException);
  });

  it("throws 404 for build.daily-snapshots when project is in a foreign tenant", async () => {
    const db = makeDb({ projectRow: undefined });
    const access = makeAccess({ scope: "all" });
    const actor = makeActor({ principal: systemJobPrincipal("build.daily-snapshots") });
    await expect(assertProjectAggregateAccess(db, access, actor, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });
});

describe("assertProjectAggregateAccess — human actor path", () => {
  it("allows a project manager with unrestricted scope", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: MEMBER_MID }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    await expect(assertProjectAggregateAccess(db, access, makeActor(), PROJECT_ID)).resolves.toBeUndefined();
  });

  it("denies a project manager with restricted own-only scope", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: MEMBER_MID }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map(), scope: "own" });
    await expect(assertProjectAggregateAccess(db, access, makeActor(), PROJECT_ID)).rejects.toThrow(ForbiddenException);
  });

  it("throws 403 for a same-tenant non-member (does not throw 404)", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: 999 }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    const err = await assertProjectAggregateAccess(db, access, makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 when project is cross-tenant (does not throw 403)", async () => {
    const db = makeDb({ projectRow: undefined });
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    const err = await assertProjectAggregateAccess(db, access, makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertTicketReadAccess", () => {
  function makeTicketDb(ticketResult: object | undefined): Db {
    const chain: Record<string, jest.Mock> = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue(ticketResult ? [ticketResult] : []),
    };
    chain["from"]!.mockReturnValue(chain);
    chain["innerJoin"]!.mockReturnValue(chain);
    chain["where"]!.mockReturnValue(chain);
    return {
      query: {
        projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: MEMBER_MID }) },
        tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      },
      select: jest.fn().mockReturnValue(chain),
      execute: jest.fn().mockResolvedValue(undefined),
    } as unknown as Db;
  }

  it("resolves when ticket is within the actor scope", async () => {
    const db = makeTicketDb({ id: TICKET_ID, allowed: true });
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    await expect(assertTicketReadAccess(db, access, makeActor(), PROJECT_ID, TICKET_ID)).resolves.toBeUndefined();
  });

  it("throws 404 when ticket does not exist in the project (conceals)", async () => {
    const db = makeTicketDb(undefined);
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    const err = await assertTicketReadAccess(db, access, makeActor(), PROJECT_ID, TICKET_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });

  it("throws 403 when ticket exists but is outside the actor data scope", async () => {
    const db = makeTicketDb({ id: TICKET_ID, allowed: false });
    const access = makeAccess({ permsMap: new Map(), scope: "own" });
    await expect(assertTicketReadAccess(db, access, makeActor(), PROJECT_ID, TICKET_ID)).rejects.toThrow(ForbiddenException);
  });

  it("throws 404 when ticket belongs to a different project (nested resource mismatch)", async () => {
    const db = makeTicketDb(undefined);
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    const err = await assertTicketReadAccess(db, access, makeActor(), PROJECT_ID + 1, TICKET_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("authorizeTicketMutation", () => {
  it("returns role and predicate for an authorized project manager", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: MEMBER_MID }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map(), scope: "all" });
    const result = await authorizeTicketMutation(db, access, makeActor(), PROJECT_ID);
    expect(result).toHaveProperty("role");
    expect(result).toHaveProperty("predicate");
    expect(result.role).toBe("MANAGER");
  });

  it("throws 403 for a same-tenant non-member", async () => {
    const db = makeDb({ projectRow: { managerMembershipId: 999 }, selectRows: [] });
    const access = makeAccess({ permsMap: new Map() });
    const err = await authorizeTicketMutation(db, access, makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });

  it("throws 404 for a cross-tenant project (conceals)", async () => {
    const db = makeDb({ projectRow: undefined });
    const err = await authorizeTicketMutation(db, makeAccess(), makeActor(), PROJECT_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });
});

describe("readMutationTickets", () => {
  const policy = {
    role: "MANAGER" as string | null,
    predicate: sql`true`,
  };

  it("returns rows when all ticket ids are found and within scope", async () => {
    const ticketRow = { id: TICKET_ID, status: "TODO", rank: "1", version: 1, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM", points: null, epicId: null, cycleId: null, allowed: true };
    const db = makeDb({ orderByForRows: [ticketRow] });
    const rows = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(TICKET_ID);
  });

  it("throws 404 when a ticket id is not found in the project (conceals)", async () => {
    const db = makeDb({ orderByForRows: [] });
    const err = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    expect(err).not.toBeInstanceOf(ForbiddenException);
  });

  it("throws 403 when a ticket exists but is outside the actor data scope", async () => {
    const ticketRow = { id: TICKET_ID, status: "TODO", rank: "1", version: 1, assigneeMembershipId: null, dueDate: null, priority: "MEDIUM", points: null, epicId: null, cycleId: null, allowed: false };
    const db = makeDb({ orderByForRows: [ticketRow] });
    const err = await readMutationTickets(db, makeActor(), PROJECT_ID, [TICKET_ID], policy).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err).not.toBeInstanceOf(NotFoundException);
  });
});
