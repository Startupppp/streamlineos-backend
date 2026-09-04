import { Test } from "@nestjs/testing";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { API_KEY_LIST_CAP, SettingsService } from "./settings.service";

/**
 * `listApiKeys` was the one read in the sixteen-file settings module with no
 * `limit`. Nothing prunes `api_keys` and no plan limit caps how many an org may
 * mint, so the response grew a row per key forever — the whole set on one
 * request, every request. It was invisible to `check:unbounded-reads` because
 * the classification verdict is keyed per FILE, and this file's justification
 * ("org settings reads bounded by orgId — single-row config lookup per org")
 * was written about the organization-config reads beside it, not about this one.
 *
 * The fixture is deliberately larger than the cap: a fixture at or below it
 * cannot see the defect, which is why it survived.
 */

const actor: CurrentUserContext = {
  userId: "org-admin",
  orgId: "org-1",
  role: "ORG_ADMIN",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, false),
};

interface StoredKey {
  id: string;
  name: string;
}

const STORED: StoredKey[] = Array.from(
  { length: API_KEY_LIST_CAP * 2 },
  (_unused, index) => ({
    id: `key-${String(index).padStart(4, "0")}`,
    name: `key ${index}`,
  }),
);

interface FindManyArgs {
  limit?: number;
  orderBy?: unknown;
}

async function buildService(): Promise<{
  service: SettingsService;
  findMany: jest.Mock;
}> {
  /**
   * The mock HONOURS `limit`. A mock that ignores it cannot see this defect,
   * because the truncation happens in Postgres and not in the service.
   */
  const findMany = jest.fn((args: FindManyArgs) =>
    Promise.resolve(STORED.slice(0, args.limit ?? STORED.length)),
  );
  const db = { query: { apiKeys: { findMany } } };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OrgMembershipService, useValue: { updateMemberRole: jest.fn() } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
    ],
  }).compile();

  return { service: moduleRef.get(SettingsService), findMany };
}

describe("listApiKeys is a bounded page, not a dump", () => {
  it("ANTI-VACUITY: the fixture holds more keys than the cap", () => {
    expect(STORED.length).toBeGreaterThan(API_KEY_LIST_CAP);
  });

  it("asks the database for at most one row past the cap", async () => {
    const { service, findMany } = await buildService();

    await service.listApiKeys(actor);

    const args = findMany.mock.calls[0]?.[0] as FindManyArgs | undefined;
    expect(args?.limit).toBe(API_KEY_LIST_CAP + 1);
  });

  it("returns the cap, never the whole set", async () => {
    const { service } = await buildService();

    const rows = await service.listApiKeys(actor);

    expect(rows).toHaveLength(API_KEY_LIST_CAP);
    expect(rows.length).toBeLessThan(STORED.length);
  });

  it("orders by a tie-break so the capped page is a stable prefix", async () => {
    const { service, findMany } = await buildService();

    await service.listApiKeys(actor);

    const args = findMany.mock.calls[0]?.[0] as FindManyArgs | undefined;
    const orderBy = args?.orderBy;
    expect(typeof orderBy).toBe("function");
    const columns = { createdAt: "createdAt", id: "id" };
    const ordering = (
      orderBy as (
        table: typeof columns,
        operators: {
          asc: (column: string) => string;
          desc: (column: string) => string;
        },
      ) => string[]
    )(columns, {
      asc: (column) => `asc(${column})`,
      desc: (column) => `desc(${column})`,
    });
    expect(ordering).toEqual(["desc(createdAt)", "asc(id)"]);
  });
});
