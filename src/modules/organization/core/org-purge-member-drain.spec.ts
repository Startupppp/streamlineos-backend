jest.mock("../../../common/relocation/relocation-traffic-tracker", () => ({
  refreshRelocationTargets: jest.fn().mockResolvedValue(undefined),
  isRelocationTarget: jest.fn().mockReturnValue(false),
}));

import { Test } from "@nestjs/testing";
import { AuditService } from "../../../common/audit/audit.service";
import { CacheService } from "../../../common/cache/cache.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { OrgPurgeService } from "./org-purge.service";
import { OrgMembershipService } from "./org-membership.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";

const MEMBER_PAGE_SIZE = 500;
const MEMBER_COUNT = 1250;

function memberPage(offset: number, size: number) {
  return new Array(size)
    .fill(null)
    .map((_, i) => ({ id: offset + i + 1, userId: `user-${offset + i + 1}` }));
}

function queryResult(rows: unknown[]) {
  const resolved = Promise.resolve(rows);
  const chain: Record<string, unknown> = {
    then: resolved.then.bind(resolved),
    catch: resolved.catch.bind(resolved),
  };
  for (const method of ["from", "innerJoin", "where", "orderBy"]) {
    chain[method] = jest.fn().mockReturnValue(chain);
  }
  chain.limit = jest.fn().mockResolvedValue(rows);
  return chain;
}

describe("OrgPurgeService member drain", () => {
  const revokeOrgScopedAccess = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidate = jest.fn().mockResolvedValue(undefined);
  const cacheInvalidateNamespace = jest.fn().mockResolvedValue(undefined);
  let selectResults: unknown[][];
  let service: OrgPurgeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    selectResults = [];
    const db: Record<string, jest.Mock> = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn(() => queryResult(selectResults.shift() ?? [])),
      update: jest.fn(() => ({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      })),
      delete: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(db)),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgPurgeService,
        { provide: DRIZZLE, useValue: db },
        { provide: AuditService, useValue: { log: jest.fn() } },
        {
          provide: CacheService,
          useValue: {
            invalidate: cacheInvalidate,
            invalidateNamespace: cacheInvalidateNamespace,
            invalidateMany: jest.fn().mockResolvedValue(undefined),
            invalidateNamespaceMany: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: OrgMembershipService, useValue: { revokeOrgScopedAccess } },
        {
          provide: OrganizationSagaService,
          useValue: {
            begin: jest
              .fn()
              .mockResolvedValue({ saga: { sagaId: "saga-drain" }, steps: [] }),
            runStep: jest.fn(
              (_sagaId: string, _step: string, fn: () => Promise<unknown>) => fn(),
            ),
            complete: jest.fn().mockResolvedValue(undefined),
            compensate: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = moduleRef.get(OrgPurgeService);
  });

  it("revokes access for every member of an organization larger than one page", async () => {
    selectResults.push([{ id: "org-1", name: "Alpha", slug: "alpha", statusV2: "ACTIVE" }]);
    selectResults.push([]);
    selectResults.push(memberPage(0, MEMBER_PAGE_SIZE));
    selectResults.push(memberPage(MEMBER_PAGE_SIZE, MEMBER_PAGE_SIZE));
    selectResults.push(memberPage(MEMBER_PAGE_SIZE * 2, MEMBER_COUNT - MEMBER_PAGE_SIZE * 2));
    for (let i = 0; i < MEMBER_COUNT; i++) selectResults.push([]);

    await service.deleteOrg("org-1", "user-1", "Alpha");

    expect(revokeOrgScopedAccess).toHaveBeenCalledTimes(MEMBER_COUNT);
    expect(revokeOrgScopedAccess).toHaveBeenCalledWith("org-1", "user-1", "removed");
    expect(revokeOrgScopedAccess).toHaveBeenCalledWith(
      "org-1",
      `user-${MEMBER_COUNT}`,
      "removed",
    );
  });

  it("stops draining as soon as a page comes back short", async () => {
    selectResults.push([{ id: "org-1", name: "Alpha", slug: "alpha", statusV2: "ACTIVE" }]);
    selectResults.push([]);
    selectResults.push(memberPage(0, 3));
    for (let i = 0; i < 3; i++) selectResults.push([]);

    await service.deleteOrg("org-1", "user-1", "Alpha");

    expect(revokeOrgScopedAccess).toHaveBeenCalledTimes(3);
  });
});
