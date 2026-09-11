import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import { CacheService } from "../../common/cache/cache.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { OrgMembershipService } from "../organization/core/org-membership.service";
import { SettingsService } from "./settings.service";

const dialect = new PgDialect();

function render(value: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]);
  return { sql: query.sql, params: query.params };
}

function actor(
  overrides: Partial<CurrentUserContext> & Pick<CurrentUserContext, "role">,
): CurrentUserContext {
  return {
    userId: "actor-1",
    orgId: "org-1",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

const MEMBER = actor({ role: "MEMBER" });
const ORG_ADMIN = actor({ role: "ORG_ADMIN" });
const OWNER = actor({
  role: "MEMBER",
  isOrgOwner: true,
  principal: humanSessionPrincipal(1, true),
});
const CLAIMS_ONLY_OWNER = actor({ role: "MEMBER", isOrgOwner: true });

async function buildService(existingKey: { id: string } | null = { id: "key-1" }) {
  const findMany = jest.fn().mockResolvedValue([]);
  const findFirst = jest.fn().mockResolvedValue(existingKey ?? undefined);
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const updateWheres: unknown[] = [];
  const sets: unknown[] = [];
  const updateBuilder: Record<string, unknown> = {
    set: jest.fn((row: unknown) => {
      sets.push(row);
      return updateBuilder;
    }),
    where: jest.fn((cond: unknown) => {
      updateWheres.push(cond);
      return Promise.resolve(undefined);
    }),
  };

  const db = {
    query: {
      apiKeys: { findMany, findFirst },
      organizationSettings: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    insert: jest.fn().mockReturnValue({ values: insertValues }),
    update: jest.fn().mockReturnValue(updateBuilder),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      SettingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: OrgMembershipService, useValue: { updateMemberRole: jest.fn() } },
      { provide: CacheService, useValue: { invalidate: jest.fn(), invalidateForOrg: jest.fn() } },
    ],
  }).compile();

  return {
    service: moduleRef.get(SettingsService),
    mocks: { findMany, findFirst, insertValues, updateWheres, sets },
  };
}

describe("SettingsService — authority is structural, not a permission key", () => {
  it("refuses a plain member on every API-key operation and touches no data", async () => {
    const { service, mocks } = await buildService();

    await expect(service.listApiKeys(MEMBER)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.createApiKey(MEMBER, { name: "k", scopes: [] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.revokeApiKey(MEMBER, "key-1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );

    expect(mocks.findMany).not.toHaveBeenCalled();
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.insertValues).not.toHaveBeenCalled();
    expect(mocks.updateWheres).toHaveLength(0);
  });

  it.each([
    ["an org admin", ORG_ADMIN],
    ["an org owner", OWNER],
  ])("admits %s, so the member refusal is the authority check and not a broken mock", async (
    _label,
    caller,
  ) => {
    const { service, mocks } = await buildService();

    await expect(service.listApiKeys(caller)).resolves.toEqual([]);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("reads ownership from the principal, never from a client-shaped isOrgOwner claim", async () => {
    const { service, mocks } = await buildService();

    await expect(service.listApiKeys(CLAIMS_ONLY_OWNER)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("SettingsService — API key reads and revocation", () => {
  it("never projects the key hash out of the database", async () => {
    const { service, mocks } = await buildService();

    await service.listApiKeys(ORG_ADMIN);

    const args = mocks.findMany.mock.calls[0][0] as { columns?: Record<string, boolean> };
    expect(args.columns).toMatchObject({ keyHash: false });
  });

  it("scopes the list to the caller org and excludes already-revoked keys", async () => {
    const { service, mocks } = await buildService();

    await service.listApiKeys(ORG_ADMIN);

    const args = mocks.findMany.mock.calls[0][0] as { where: unknown };
    const { sql, params } = render(args.where);
    expect(sql).toContain('"api_keys"."org_id" = $');
    expect(sql).toContain('"api_keys"."is_revoked" = $');
    expect(params).toContain("org-1");
    expect(params).toContain(false);
  });

  it("revokes by setting isRevoked, scoped to both the key id and the caller org", async () => {
    const { service, mocks } = await buildService();

    await expect(service.revokeApiKey(ORG_ADMIN, "key-1")).resolves.toEqual({ success: true });

    expect(mocks.sets).toEqual([{ isRevoked: true }]);
    const { sql, params } = render(mocks.updateWheres[0]);
    expect(sql).toContain('"api_keys"."id" = $');
    expect(sql).toContain('"api_keys"."org_id" = $');
    expect(params).toEqual(expect.arrayContaining(["key-1", "org-1"]));
  });

  it("answers NotFound for another org's key id and writes nothing", async () => {
    const { service, mocks } = await buildService(null);

    await expect(service.revokeApiKey(ORG_ADMIN, "key-foreign")).rejects.toBeInstanceOf(
      NotFoundException,
    );

    expect(mocks.updateWheres).toHaveLength(0);
  });
});
