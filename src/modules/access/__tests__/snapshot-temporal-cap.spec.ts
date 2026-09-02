import { AccessPermissionResolver } from "../access-permission.resolver";
import { NO_TRANSITIONS, type Clock } from "../snapshot-validity";
import type { Db } from "../../../db/drizzle.module";

const GRANT_KEY = "hr:employees:view";
const ORG = "org-1";
const USER = "u-1";

const BASE_NOW = new Date("2026-06-01T12:00:00.000Z");

type DelegationRow = {
  permissionKey: string;
  startsAt: Date;
  endsAt: Date;
};

type AssignmentRow = {
  roleId: number;
  expiresAt: Date | null;
};

type BuildOptions = {
  clockNow?: Date;
  delegationRows?: DelegationRow[];
  assignmentRows?: AssignmentRow[];
  isOwner?: boolean;
  memberRole?: string;
};

function buildResolver(options: BuildOptions = {}): AccessPermissionResolver {
  const clockNow = options.clockNow ?? BASE_NOW;
  const clock: Clock = { now: () => clockNow };

  const hasRoles =
    options.assignmentRows !== undefined && options.assignmentRows.length > 0;

  const queue: unknown[][] = [
    options.assignmentRows ?? [],
    [],
    [],
    [],
    ...(hasRoles
      ? [
          [
            {
              id: options.assignmentRows?.[0]?.roleId ?? 1,
              slug: "HR_MODULE_MEMBER",
            },
          ],
          [],
        ]
      : []),
    options.delegationRows ?? [],
  ];

  let cursor = 0;

  const chain = (): Record<string, unknown> => {
    const link: Record<string, unknown> = {};
    link["from"] = () => link;
    link["innerJoin"] = () => link;
    link["where"] = () => link;
    link["orderBy"] = () => link;
    link["limit"] = () => Promise.resolve(queue[cursor++] ?? []);
    return link;
  };

  const db = {
    query: {
      organizationMembers: {
        findFirst: () =>
          Promise.resolve({
            isOwner: options.isOwner ?? false,
            status: "ACTIVE",
            id: 42,
            role: options.memberRole ?? "MEMBER",
          }),
      },
    },
    select: () => chain(),
  } as unknown as Db;

  return new AccessPermissionResolver(
    () => db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    clock,
  );
}

describe("delegation temporal authorization", () => {
  it("grants a permission from an active delegation and surfaces delegationEnd in transitions", async () => {
    const endsAt = new Date(BASE_NOW.getTime() + 10_000);
    const resolver = buildResolver({
      delegationRows: [
        {
          permissionKey: GRANT_KEY,
          startsAt: new Date(BASE_NOW.getTime() - 5_000),
          endsAt,
        },
      ],
    });
    const { perms, transitions } = await resolver.computeUserPermissions(
      ORG,
      USER,
      1,
    );
    expect(perms[GRANT_KEY]).toBe("all");
    expect(transitions.delegationEnd).toEqual(endsAt);
  });

  it("does not grant a permission whose startsAt is in the future and surfaces delegationStart", async () => {
    const startsAt = new Date(BASE_NOW.getTime() + 5_000);
    const resolver = buildResolver({
      delegationRows: [
        {
          permissionKey: GRANT_KEY,
          startsAt,
          endsAt: new Date(BASE_NOW.getTime() + 15_000),
        },
      ],
    });
    const { perms, transitions } = await resolver.computeUserPermissions(
      ORG,
      USER,
      1,
    );
    expect(perms[GRANT_KEY]).toBeUndefined();
    expect(transitions.delegationStart).toEqual(startsAt);
  });

  it("grants the permission once the clock advances past startsAt", async () => {
    const startsAt = new Date(BASE_NOW.getTime() + 5_000);
    const resolver = buildResolver({
      clockNow: new Date(startsAt.getTime() + 1),
      delegationRows: [
        {
          permissionKey: GRANT_KEY,
          startsAt,
          endsAt: new Date(BASE_NOW.getTime() + 15_000),
        },
      ],
    });
    const { perms } = await resolver.computeUserPermissions(ORG, USER, 1);
    expect(perms[GRANT_KEY]).toBe("all");
  });

  it("removes the permission once the clock advances past endsAt", async () => {
    const resolver = buildResolver({
      clockNow: new Date(BASE_NOW.getTime() + 20_000),
      delegationRows: [],
    });
    const { perms } = await resolver.computeUserPermissions(ORG, USER, 1);
    expect(perms[GRANT_KEY]).toBeUndefined();
  });
});

describe("role assignment temporal authorization", () => {
  it("surfaces a future role expiry as roleAssignmentExpiry in transitions", async () => {
    const expiresAt = new Date(BASE_NOW.getTime() + 10_000);
    const resolver = buildResolver({
      assignmentRows: [{ roleId: 1, expiresAt }],
    });
    const { transitions } = await resolver.computeUserPermissions(ORG, USER, 1);
    expect(transitions.roleAssignmentExpiry).toEqual(expiresAt);
  });
});

describe("time-unbounded standing", () => {
  it("returns NO_TRANSITIONS for an org owner", async () => {
    const resolver = buildResolver({ isOwner: true });
    const { transitions } = await resolver.computeUserPermissions(ORG, USER, 1);
    expect(transitions).toEqual(NO_TRANSITIONS);
  });

  it("returns NO_TRANSITIONS for an ORG_ADMIN", async () => {
    const resolver = buildResolver({ memberRole: "ORG_ADMIN" });
    const { transitions } = await resolver.computeUserPermissions(ORG, USER, 1);
    expect(transitions).toEqual(NO_TRANSITIONS);
  });
});
