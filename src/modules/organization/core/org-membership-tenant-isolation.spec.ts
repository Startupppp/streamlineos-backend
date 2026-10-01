jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { AblyService } from "../../realtime/ably.service";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { EmailService } from "../../email/email.service";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";
import { SessionsService } from "../../sessions/sessions.service";
import { OrgMemberDepartureService } from "./org-member-departure.service";
import { OrgMembershipReadService } from "./org-membership-read.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrgMembershipStatusService } from "./org-membership-status.service";

const dialect = new PgDialect();
const MEMBER_USER = "user-member";
const ACTOR_USER = "user-attacker-actor";
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

interface FindFirstArgs {
  where?: SQL;
}

function sqlValues(where: SQL | undefined): unknown[] {
  if (!where) return [];
  return dialect.sqlToQuery(where).params;
}

describe("OrgMembershipService — cross-tenant membership mutations", () => {
  let capturedWheres: SQL[];
  let selectResults: unknown[][];
  let db: Record<string, unknown>;
  let service: OrgMembershipService;

  function chain(rows: unknown[]) {
    const resolved = Promise.resolve(rows);
    const node: Record<string, unknown> = {
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    };
    for (const method of ["from", "innerJoin", "orderBy", "for"])
      node[method] = jest.fn().mockReturnValue(node);
    node.where = jest.fn((w: SQL) => {
      capturedWheres.push(w);
      return node;
    });
    node.limit = jest.fn().mockResolvedValue(rows);
    return node;
  }

  beforeEach(async () => {
    jest.resetAllMocks();
    capturedWheres = [];
    selectResults = [];
    db = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn(() => chain(selectResults.shift() ?? [])),
      update: jest.fn(() => ({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
      query: {
        organizationMembers: {
          findFirst: jest.fn((args: FindFirstArgs) => {
            if (args?.where) capturedWheres.push(args.where);
            return Promise.resolve(undefined);
          }),
        },
      },
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgMembershipService,
        OrgMembershipStatusService,
        OrgMemberDepartureService,
        { provide: DRIZZLE, useValue: db },
        { provide: AblyService, useValue: {} },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceForOrg: jest.fn().mockResolvedValue(undefined),
            invalidateForOrg: jest.fn().mockResolvedValue(undefined),
            cachedVersionedForOrg: jest.fn(),
          },
        },
        { provide: SessionsService, useValue: {} },
        {
          provide: AccessService,
          useValue: { canManageOrganizationMembership: jest.fn().mockResolvedValue(true) },
        },
        { provide: EmailService, useValue: {} },
        {
          provide: NotificationDispatchService,
          useValue: {
            emit: jest.fn().mockResolvedValue(undefined),
            emitInTx: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: OrgMembershipReadService, useValue: { list: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(OrgMembershipService);
  });

  it("DENY: suspendMember rejects a membership seeded under a different org, never a cross-tenant existence oracle", async () => {
    const error: unknown = await service
      .suspendMember(ATTACKER_ORG, ACTOR_USER, MEMBER_USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();

    const params = sqlValues(capturedWheres.at(-1));
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("DENY: removeMember rejects a membership seeded under a different org, never a cross-tenant existence oracle", async () => {
    const error: unknown = await service
      .removeMember(ATTACKER_ORG, ACTOR_USER, MEMBER_USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();

    const params = sqlValues(capturedWheres.at(-1));
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });

  it("DENY: updateMemberRole rejects a membership seeded under a different org, never a cross-tenant existence oracle", async () => {
    const error: unknown = await service
      .updateMemberRole(ATTACKER_ORG, { userId: ACTOR_USER, isOrgOwner: true }, MEMBER_USER, "MEMBER")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
    expect(db.delete).not.toHaveBeenCalled();

    const params = sqlValues(capturedWheres.at(-1));
    expect(params).toContain(ATTACKER_ORG);
    expect(params).not.toContain(OWNER_ORG);
  });
});
