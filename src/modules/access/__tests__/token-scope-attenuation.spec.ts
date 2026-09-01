import { ForbiddenException } from "@nestjs/common";
import { grantablePersonalTokenPermissions } from "../../api-tokens/user/personal-token-scope-policy";
import { isPersonalTokenPermissionDelegable } from "../../../common/rbac/personal-token-policy";
import { UserApiTokensService } from "../../api-tokens/user/user-api-tokens.service";
import type { AccessSnapshot } from "../access.types";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeSnapshot(
  scopes: Record<string, string>,
  modules: Record<string, boolean> = {},
  isOrgOwner = false,
): AccessSnapshot {
  return {
    scopes: scopes as AccessSnapshot["scopes"],
    modules,
    isOrgOwner,
    canManageOrganizationMembership: isOrgOwner,
    mfa: { enforced: false, satisfied: true },
    version: 1,
  };
}

function makeUser(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-1",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

describe("isPersonalTokenPermissionDelegable — high-risk prefixes are excluded", () => {
  it.each([
    ["billing:subscription:manage", false],
    ["billing:invoices:view", false],
    ["ownership:org:transfer", false],
    ["settings:manage", false],
    ["settings:rbac:manage", false],
    ["hr:employees:view", true],
    ["crm:leads:view", true],
    ["build:tickets:create", true],
    ["chat:messages:read", true],
  ] as Array<[string, boolean]>)(
    "%s → delegable=%s",
    (key, expected) => {
      expect(isPersonalTokenPermissionDelegable(key)).toBe(expected);
    },
  );
});

describe("grantablePersonalTokenPermissions — snapshot-driven attenuation", () => {
  it("includes a permission the user holds in an enabled module", () => {
    const snapshot = makeSnapshot(
      { "hr:employees:view": "all" },
      { hr: true },
    );
    const grantable = grantablePersonalTokenPermissions(snapshot);
    expect(grantable.map((p) => p.name)).toContain("hr:employees:view");
  });

  it("excludes a permission from a disabled module", () => {
    const snapshot = makeSnapshot(
      { "crm:leads:view": "all" },
      { crm: false },
    );
    const grantable = grantablePersonalTokenPermissions(snapshot);
    expect(grantable.map((p) => p.name)).not.toContain("crm:leads:view");
  });

  it("excludes a billing permission even when the user holds it", () => {
    const snapshot = makeSnapshot(
      { "billing:subscription:manage": "all" },
      { billing: true },
    );
    const grantable = grantablePersonalTokenPermissions(snapshot);
    expect(grantable.map((p) => p.name)).not.toContain("billing:subscription:manage");
  });

  it("excludes an ownership permission regardless of module enablement", () => {
    const snapshot = makeSnapshot(
      { "ownership:org:transfer": "all" },
      {},
    );
    const grantable = grantablePersonalTokenPermissions(snapshot);
    expect(grantable.map((p) => p.name)).not.toContain("ownership:org:transfer");
  });

  it("excludes a settings permission from a non-owner", () => {
    const snapshot = makeSnapshot(
      { "settings:manage": "all" },
      {},
    );
    const grantable = grantablePersonalTokenPermissions(snapshot);
    expect(grantable.map((p) => p.name)).not.toContain("settings:manage");
  });

  it("returns an empty list when the user holds no permissions", () => {
    const snapshot = makeSnapshot({}, {});
    expect(grantablePersonalTokenPermissions(snapshot)).toHaveLength(0);
  });

  it("scope change: removing a permission from the snapshot drops it from grantable immediately", () => {
    const snapshotBefore = makeSnapshot(
      { "hr:employees:view": "all", "hr:employees:manage": "all" },
      { hr: true },
    );
    const snapshotAfter = makeSnapshot(
      { "hr:employees:view": "all" },
      { hr: true },
    );

    const before = grantablePersonalTokenPermissions(snapshotBefore).map((p) => p.name);
    const after = grantablePersonalTokenPermissions(snapshotAfter).map((p) => p.name);

    expect(before).toContain("hr:employees:manage");
    expect(after).not.toContain("hr:employees:manage");
    expect(after).toContain("hr:employees:view");
  });

  it("module disable: disabling a module drops all its permissions from grantable", () => {
    const snapshotEnabled = makeSnapshot(
      { "hr:employees:view": "all", "hr:leaves:view": "all" },
      { hr: true },
    );
    const snapshotDisabled = makeSnapshot(
      { "hr:employees:view": "all", "hr:leaves:view": "all" },
      { hr: false },
    );

    const enabled = grantablePersonalTokenPermissions(snapshotEnabled).map((p) => p.name);
    const disabled = grantablePersonalTokenPermissions(snapshotDisabled).map((p) => p.name);

    expect(enabled.some((k) => k.startsWith("hr:"))).toBe(true);
    expect(disabled.some((k) => k.startsWith("hr:"))).toBe(false);
  });
});

describe("UserApiTokensService.create — scope enforcement prevents token over-escalation", () => {
  function buildService(snapshotScopes: Record<string, string>) {
    const snapshot = makeSnapshot(snapshotScopes, { hr: true });
    const access = {
      getAccessSnapshot: jest.fn().mockResolvedValue(snapshot),
    };
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{
            id: "tok-1",
            userId: "u-1",
            name: "Test token",
            prefix: "pat_test",
            scopes: Object.keys(snapshotScopes),
            expiresAt: new Date(Date.now() + 86400 * 1000),
            lastUsedAt: null,
            createdAt: new Date(),
          }]),
        }),
      }),
    };
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };

    const service = new UserApiTokensService(
      db as never,
      dispatch as never,
      access as never,
    );
    return { service, access };
  }

  it("refuses a scope the user does not hold, even if requested", async () => {
    const { service } = buildService({ "hr:employees:view": "all" });

    await expect(
      service.create(makeUser(), {
        name: "Over-scoped token",
        scopes: ["hr:employees:view", "hr:employees:manage"],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a billing scope the user holds (billing is not delegable to tokens)", async () => {
    const { service } = buildService({ "billing:subscription:manage": "all" });

    await expect(
      service.create(makeUser(), {
        name: "Billing token attempt",
        scopes: ["billing:subscription:manage"],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("refuses a settings scope (settings is not delegable to personal tokens)", async () => {
    const { service } = buildService({ "settings:manage": "all" });

    await expect(
      service.create(makeUser(), {
        name: "Settings token attempt",
        scopes: ["settings:manage"],
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a subset of the user's delegable permissions", async () => {
    const { service } = buildService({
      "hr:employees:view": "all",
      "hr:leaves:view": "all",
    });

    const result = await service.create(makeUser(), {
      name: "Subset token",
      scopes: ["hr:employees:view"],
    });

    expect(result).toMatchObject({ id: "tok-1", name: "Test token" });
  });

  it("new token has lastUsedAt=null at creation (last-used is updated on first request, not on issue)", async () => {
    const { service } = buildService({ "hr:employees:view": "all" });

    const result = await service.create(makeUser(), {
      name: "Fresh token",
      scopes: ["hr:employees:view"],
    });

    expect(result.lastUsedAt).toBeNull();
  });

  it("stores the requested expiresAt on the token row", async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    const snapshotScopes = { "hr:employees:view": "all" };
    const snapshot = makeSnapshot(snapshotScopes, { hr: true });
    const access = { getAccessSnapshot: jest.fn().mockResolvedValue(snapshot) };
    const inserted: Array<{ expiresAt: Date | null }> = [];
    const db = {
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockImplementation((row: { expiresAt: Date | null }) => {
          inserted.push({ expiresAt: row.expiresAt });
          return {
            returning: jest.fn().mockResolvedValue([{
              id: "tok-2",
              userId: "u-1",
              name: "Expiring token",
              prefix: "pat_exp",
              scopes: ["hr:employees:view"],
              expiresAt,
              lastUsedAt: null,
              createdAt: new Date(),
            }]),
          };
        }),
      }),
    };
    const dispatch = { emit: jest.fn().mockResolvedValue(undefined) };
    const service = new UserApiTokensService(db as never, dispatch as never, access as never);

    await service.create(makeUser(), {
      name: "Expiring token",
      scopes: ["hr:employees:view"],
      expiresAt: expiresAt.toISOString() as never,
    });

    expect(inserted[0]?.expiresAt).toEqual(expiresAt.toISOString());
  });
});
