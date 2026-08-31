jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import { OrgLifecycleService } from "./org-lifecycle.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

const dialect = new PgDialect();
const OWNER_USER = "user-owner";
const ATTACKER_USER = "user-attacker";
const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function sqlValues(where: SQL | undefined): unknown[] {
  if (!where) return [];
  return dialect.sqlToQuery(where).params;
}

describe("OrgLifecycleService — cross-tenant and cross-user isolation", () => {
  let capturedWheres: SQL[];
  let selectResults: unknown[][];
  let db: Record<string, unknown>;
  let service: OrgLifecycleService;

  function chain(rows: unknown[]) {
    const resolved = Promise.resolve(rows);
    const node: Record<string, unknown> = {
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    };
    for (const method of ["from", "innerJoin", "orderBy"])
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
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgLifecycleService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: OrgMembershipService, useValue: { revokeOrgScopedAccess: jest.fn() } },
        { provide: InvitationLifecycleService, useValue: { revokeAllPending: jest.fn() } },
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: jest.fn().mockResolvedValue({ saga: { sagaId: "s1" }, steps: [] }),
            runStep: jest.fn((_s: string, _n: string, fn: () => Promise<unknown>) => fn()),
            complete: jest.fn().mockResolvedValue(undefined),
            compensate: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(OrgLifecycleService);
  });

  it("DENY: listArchivedOwnedOrganizations binds the caller, so it cannot list another user's archived orgs", async () => {
    selectResults.push([]);
    await service.listArchivedOwnedOrganizations(ATTACKER_USER);

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(ATTACKER_USER);
    expect(params).not.toContain(OWNER_USER);
  });

  it("CONTROL: the same read binds the legitimate owner and returns their rows", async () => {
    selectResults.push([{ id: OWNER_ORG, name: "Owner Org", slug: "owner-org" }]);
    const rows = await service.listArchivedOwnedOrganizations(OWNER_USER);

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(OWNER_USER);
    expect(rows).toEqual([{ id: OWNER_ORG, name: "Owner Org", slug: "owner-org" }]);
  });

  it("DENY: listArchivedOwnedOrganizations requires ownership and active membership, not membership alone", async () => {
    selectResults.push([]);
    await service.listArchivedOwnedOrganizations(OWNER_USER);

    const params = capturedWheres.flatMap(sqlValues);
    expect(params).toContain(true);
    expect(params).toContain("ACTIVE");
    expect(params).toContain("ARCHIVED");
  });

  it("DENY: archiving an org outside the caller's tenant is 404, never 403", async () => {
    selectResults.push([]);

    const error: unknown = await service
      .archiveOrg(ATTACKER_ORG, OWNER_USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
  });

  it("DENY: restoring an org outside the caller's tenant is 404, never 403", async () => {
    selectResults.push([]);

    const error: unknown = await service
      .restoreOrg(ATTACKER_ORG, OWNER_USER)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NotFoundException);
    expect(error).not.toBeInstanceOf(ForbiddenException);
  });
});
