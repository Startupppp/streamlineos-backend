import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";
import { AccessPermissionResolver } from "../access-permission.resolver";
import type { Db } from "../../../db/drizzle.module";

/**
 * The Home module is what every active member keeps whatever else they hold:
 * calendar, chat, the mail inbox, clocking in and time off. These resolve
 * before any role is read, so no role change and no revocation can take them
 * away.
 */
const HOME_SURFACES: ReadonlyArray<[string, string]> = [
  ["calendar", "calendar:read"],
  ["calendar", "calendar:write"],
  ["chat", "chat:channels:read"],
  ["chat", "chat:channels:write"],
  ["chat", "chat:messages:read"],
  ["chat", "chat:messages:write"],
  ["inbox", "mail:inbox:view"],
  ["inbox", "mail:messages:send"],
  ["clock-in", "self:attendance"],
  ["time off", "self:leaves"],
];

function resolverForMemberWithNoRoles(): AccessPermissionResolver {
  const db = {
    query: {
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({
            isOwner: false,
            status: "ACTIVE",
            id: 1,
            role: "MEMBER",
          }),
      },
    },
    select: () => ({
      from: () => ({
        innerJoin: () => ({ where: () => Promise.resolve([]) }),
        where: () => Promise.resolve([]),
      }),
    }),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
  );
}

describe("Home surfaces are allowed to everyone", () => {
  const universal = new Set(
    EMPLOYEE_SELF_SERVICE_GRANTS.map((grant) => grant.permissionKey),
  );

  it.each(HOME_SURFACES)(
    "%s is universal, not a revocable role grant (%s)",
    (_surface, key) => {
      expect(universal.has(key)).toBe(true);
    },
  );

  it("gives a suspended member nothing, universal or otherwise", async () => {
    const db = {
      query: {
        organizationMembers: {
          findFirst: () =>
            Promise.resolve({
              isOwner: false,
              status: "SUSPENDED",
              id: 1,
              role: "MEMBER",
            }),
        },
      },
      select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    } as unknown as Db;

    const resolver = new AccessPermissionResolver(
      () => db,
      (read) => read() as Promise<never>,
      new Set<string>(),
      new Map(),
      1000,
    );
    const resolved = await resolver.computeUserPermissions("org-1", "u-1");
    expect(resolved).toEqual({});
    for (const [, key] of HOME_SURFACES) expect(resolved[key]).toBeUndefined();
  });

  it("resolves them for an active member holding no role at all", async () => {
    const resolved = await resolverForMemberWithNoRoles().computeUserPermissions(
      "org-1",
      "u-1",
    );
    for (const [, key] of HOME_SURFACES) expect(resolved[key]).toBeDefined();
  });

  it.each([
    "chat:org-settings:manage",
    "chat:huddles:moderate",
    "home:access:manage",
  ])("keeps %s out of the universal set, so it stays delegatable", (key) => {
    expect(universal.has(key)).toBe(false);
  });
});
