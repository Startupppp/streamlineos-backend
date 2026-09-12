import { PgDialect } from "drizzle-orm/pg-core";
import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import { isDelegablePermission } from "../../../common/rbac/grantability";
import type { Db } from "../../../db/drizzle.module";
import {
  ROLE_DEFAULT_PERMISSIONS,
  UNIVERSAL_MEMBER_PERMISSION_GRANTS,
  moduleScopedPermissions,
} from "../../rbac/permissions";
import { EMPLOYEE_SELF_SERVICE_GRANTS } from "../access-policy";

const ORG = "org-cap-determinism";
const USER = "u-cap-determinism";

/**
 * The four standing reads used to apply a fixed cap — 500, 500, 100, 500 — and
 * past it they dropped rows with no error, no log and no flag. Truncation is
 * always privilege LOSS, so that was an intermittent denial of standing the
 * member actually held. They now drain by keyset at this page size, which is a
 * page boundary rather than a cap: the tests below cross it and expect every row.
 */
const PAGE_SIZE = 500;

/** The old caps, kept so the over-the-limit fixtures are provably past them. */
const OLD_ASSIGNMENT_CAP = 500;
const OLD_OWNERSHIP_CAP = 100;

const GROUP_PREFIX = "grp-";

type Site =
  | "role-assignments"
  | "group-memberships"
  | "module-ownerships"
  | "group-roles"
  | "roles"
  | "role-grants"
  | "user-grants"
  | "delegations"
  | "unknown";

interface ChainRecord {
  site: Site;
  calls: string[];
  orderByArgs: unknown[];
  whereParams: unknown[];
  limitArg: unknown;
}

interface AssignmentRow {
  id: string;
  roleId: number;
  expiresAt: Date | null;
}

interface GroupMemberRow {
  id: string;
  principalGroupId: string;
}

interface OwnershipRow {
  id: string;
  moduleKey: string;
}

interface GroupRoleRow {
  id: string;
  roleId: number;
}

interface Fixture {
  roleAssignments: AssignmentRow[];
  groupMemberships: GroupMemberRow[];
  moduleOwnerships: OwnershipRow[];
  groupRolesFor: (groupIds: string[]) => GroupRoleRow[];
  roleSlugs: Map<number, string>;
}

interface Recorder {
  chains: ChainRecord[];
  db: Db;
}

/** The projection is unique per read, so it is what identifies the site. */
function siteOf(columns: Set<string>): Site {
  if (columns.has("expiresAt")) return "role-assignments";
  if (columns.has("principalGroupId")) return "group-memberships";
  if (columns.has("moduleKey")) return "module-ownerships";
  if (columns.has("slug")) return "roles";
  if (columns.has("delegationId")) return "delegations";
  if (columns.has("roleId") && columns.has("permissionKey")) return "role-grants";
  if (columns.has("permissionKey")) return "user-grants";
  if (columns.has("roleId")) return "group-roles";
  return "unknown";
}

const dialect = new PgDialect();

function renderOrderBy(args: unknown[]): string {
  return args
    .map((arg) => {
      try {
        return dialect.sqlToQuery(arg as never).sql;
      } catch {
        return "";
      }
    })
    .join(" ");
}

/**
 * The bound values the predicate actually carries. The group-role read is the
 * only site whose rows depend on another site's output, so this is how the
 * fixture proves the 501st group id reached the query rather than being dropped
 * one read earlier.
 */
function renderParams(args: unknown[]): unknown[] {
  const params: unknown[] = [];
  for (const arg of args) {
    try {
      params.push(...dialect.sqlToQuery(arg as never).params);
    } catch {
      continue;
    }
  }
  return params;
}

function groupIdsIn(params: unknown[]): string[] {
  return params.filter(
    (param): param is string =>
      typeof param === "string" && param.startsWith(GROUP_PREFIX),
  );
}

function emptyFixture(): Fixture {
  return {
    roleAssignments: [],
    groupMemberships: [],
    moduleOwnerships: [],
    groupRolesFor: () => [],
    roleSlugs: new Map<number, string>(),
  };
}

function buildRecorder(fixture: Fixture): Recorder {
  const chains: ChainRecord[] = [];
  const served = new Map<Site, number>();
  let groupRoleRows: GroupRoleRow[] | null = null;

  /**
   * Honours the `limit` argument, which is the whole point: the truncation this
   * suite is about happens in Postgres, so a fake that ignores `.limit()` cannot
   * see it — restore any cap on a read below and the fixture must lose the rows
   * past it exactly as the database would.
   */
  const pageFrom = (
    site: Site,
    rows: readonly unknown[],
    count: number,
  ): unknown[] => {
    const from = served.get(site) ?? 0;
    const page = rows.slice(from, from + count);
    served.set(site, from + page.length);
    return page;
  };

  const rowsFor = (record: ChainRecord, count: number): unknown[] => {
    switch (record.site) {
      case "role-assignments":
        return pageFrom(record.site, fixture.roleAssignments, count);
      case "group-memberships":
        return pageFrom(record.site, fixture.groupMemberships, count);
      case "module-ownerships":
        return pageFrom(record.site, fixture.moduleOwnerships, count);
      case "group-roles":
        if (groupRoleRows === null)
          groupRoleRows = fixture.groupRolesFor(
            groupIdsIn(record.whereParams),
          );
        return pageFrom(record.site, groupRoleRows, count);
      case "roles":
        return Array.from(fixture.roleSlugs.entries())
          .map(([id, slug]) => ({ id, slug }))
          .slice(0, count);
      default:
        return [];
    }
  };

  const makeChain = (
    projection?: Record<string, unknown>,
  ): Record<string, unknown> => {
    const record: ChainRecord = {
      site: siteOf(new Set(Object.keys(projection ?? {}))),
      calls: [],
      orderByArgs: [],
      whereParams: [],
      limitArg: null,
    };
    chains.push(record);
    const link: Record<string, unknown> = {};
    const passthrough = (name: string) => (...args: unknown[]) => {
      record.calls.push(name);
      if (name === "orderBy") record.orderByArgs.push(...args);
      if (name === "where") record.whereParams.push(...renderParams(args));
      return link;
    };
    link["from"] = passthrough("from");
    link["innerJoin"] = passthrough("innerJoin");
    link["leftJoin"] = passthrough("leftJoin");
    link["where"] = passthrough("where");
    link["orderBy"] = passthrough("orderBy");
    link["limit"] = (...args: unknown[]) => {
      record.calls.push("limit");
      const count = args[0];
      record.limitArg = count;
      return Promise.resolve(
        rowsFor(record, typeof count === "number" ? count : PAGE_SIZE),
      );
    };
    return link;
  };

  const db = {
    query: {},
    select: (projection?: Record<string, unknown>) => makeChain(projection),
    selectDistinct: (projection?: Record<string, unknown>) =>
      makeChain(projection),
  } as unknown as Db;

  return { chains, db };
}

async function resolveWith(
  fixture: Fixture,
): Promise<{ recorder: Recorder; perms: Record<string, string> }> {
  const recorder = buildRecorder(fixture);

  const resolver = new AccessPermissionResolver(
    () => recorder.db,
    (read) => read() as Promise<never>,
    new Set<string>(),
    new Map(),
    1000,
    memberRowReader({
      isOwner: false,
      status: "ACTIVE",
      id: 42,
      role: ORG_MEMBER_ROLES.MEMBER,
    }),
  );

  const { perms } = await resolver.computeUserPermissions(ORG, USER, 1);
  return { recorder, perms };
}

/** The baseline fixture: one row per site, well inside a single page. */
function singleRowFixture(): Fixture {
  return {
    ...emptyFixture(),
    roleAssignments: [{ id: "ra-1", roleId: 7, expiresAt: null }],
    groupMemberships: [{ id: "gm-1", principalGroupId: `${GROUP_PREFIX}1` }],
    groupRolesFor: () => [{ id: "gr-1", roleId: 9 }],
    roleSlugs: new Map([
      [7, "CUSTOM_ROLE_7"],
      [9, "CUSTOM_ROLE_9"],
    ]),
  };
}

async function resolveWithRecorder(): Promise<Recorder> {
  const { recorder } = await resolveWith(singleRowFixture());
  return recorder;
}

/** Every read that pages at `PAGE_SIZE` — the four standing reads plus the three grant drains. */
function pagedChains(recorder: Recorder): ChainRecord[] {
  return recorder.chains.filter(
    (chain) => chain.calls.includes("limit") && chain.limitArg === PAGE_SIZE,
  );
}

function queriesFor(recorder: Recorder, site: Site): number {
  return recorder.chains.filter((chain) => chain.site === site).length;
}

const ALWAYS_GRANTED = new Set<string>([
  ...UNIVERSAL_MEMBER_PERMISSION_GRANTS.map((grant) => grant.permissionKey),
  ...EMPLOYEE_SELF_SERVICE_GRANTS.map((grant) => grant.permissionKey),
]);

/** Keys the admin slug's defaults are the ONLY source of, so one late role decides them. */
const ADMIN_ONLY_KEYS = (ROLE_DEFAULT_PERMISSIONS.ORG_ADMIN ?? []).filter(
  (key) => !ALWAYS_GRANTED.has(key),
);

/** Keys that arrive only by expanding one module ownership. */
const OWNED_MODULE = "crm";
const OWNED_MODULE_KEYS = moduleScopedPermissions(OWNED_MODULE)
  .filter(isDelegablePermission)
  .filter((key) => !ALWAYS_GRANTED.has(key));

const SCOPES_NOTHING = "module-that-scopes-nothing";

function slugFor(roleId: number, adminRoleId: number): string {
  return roleId === adminRoleId ? "ORG_ADMIN" : `CUSTOM_ROLE_${roleId}`;
}

function slugMap(roleIds: readonly number[], adminRoleId: number): Map<number, string> {
  return new Map(roleIds.map((roleId) => [roleId, slugFor(roleId, adminRoleId)]));
}

describe("bounded access reads are deterministically ordered", () => {
  it("issues seven paged reads under a non-owner member, so the owner short-circuit is not what is measured", async () => {
    const recorder = await resolveWithRecorder();
    expect(pagedChains(recorder)).toHaveLength(7);
  });

  it("never issues a paged LIMIT without an ORDER BY applied before it", async () => {
    const recorder = await resolveWithRecorder();
    const paged = pagedChains(recorder);
    expect(paged).toHaveLength(7);

    const unordered = paged.filter((chain) => {
      const orderByIndex = chain.calls.indexOf("orderBy");
      const limitIndex = chain.calls.indexOf("limit");
      return orderByIndex === -1 || orderByIndex > limitIndex;
    });
    expect(unordered.map((chain) => chain.calls)).toEqual([]);
  });

  it("orders the role-assignment, group-membership, module-ownership and group-role reads by a unique column", async () => {
    const recorder = await resolveWithRecorder();
    const joined = pagedChains(recorder)
      .map((chain) => renderOrderBy(chain.orderByArgs))
      .join(" | ");

    expect(joined).toContain("role_assignments");
    expect(joined).toContain("principal_group_members");
    expect(joined).toContain("module_ownerships");
    expect(joined).toContain("group_role_assignments");
  });

  it("renders every paged ORDER BY as an ascending clause on a concrete column", async () => {
    const recorder = await resolveWithRecorder();
    const rendered = pagedChains(recorder).map((chain) =>
      renderOrderBy(chain.orderByArgs),
    );

    expect(rendered).toHaveLength(7);
    for (const clause of rendered) {
      expect(clause).not.toBe("");
      expect(clause.toLowerCase()).toContain("asc");
    }
  });

  it("leaves the roles lookup unordered because its bound is the id list itself and cannot truncate", async () => {
    const recorder = await resolveWithRecorder();
    const rolesLookup = recorder.chains.filter(
      (chain) => chain.site === "roles",
    );

    expect(rolesLookup).toHaveLength(1);
    expect(rolesLookup[0]?.limitArg).toBe(2);
    expect(rolesLookup[0]?.orderByArgs).toEqual([]);
  });
});

describe("standing reads page instead of truncating", () => {
  it("ANTI-VACUITY: the admin slug and the owned module each contribute keys nothing else grants", () => {
    expect(ADMIN_ONLY_KEYS.length).toBeGreaterThan(0);
    expect(OWNED_MODULE_KEYS.length).toBeGreaterThan(0);
    expect(moduleScopedPermissions(SCOPES_NOTHING)).toEqual([]);
  });

  it("costs exactly one query per site when the tenant's rows fit inside a page", async () => {
    const roleIds = Array.from({ length: PAGE_SIZE - 1 }, (_row, i) => i + 1);
    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      roleAssignments: roleIds.map((roleId) => ({
        id: `ra-${roleId}`,
        roleId,
        expiresAt: null,
      })),
      moduleOwnerships: [{ id: "mo-1", moduleKey: OWNED_MODULE }],
      roleSlugs: slugMap(roleIds, PAGE_SIZE - 1),
    });

    expect(queriesFor(recorder, "role-assignments")).toBe(1);
    expect(queriesFor(recorder, "module-ownerships")).toBe(1);
    expect(queriesFor(recorder, "user-grants")).toBe(1);
    expect(queriesFor(recorder, "group-memberships")).toBe(1);
    expect(
      recorder.chains.filter((chain) => chain.site === "roles")[0]?.limitArg,
    ).toBe(roleIds.length);
    expect(ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
  });

  it("returns every row of an exactly-full page, at the cost of one short probe", async () => {
    const roleIds = Array.from({ length: PAGE_SIZE }, (_row, i) => i + 1);
    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      roleAssignments: roleIds.map((roleId) => ({
        id: `ra-${roleId}`,
        roleId,
        expiresAt: null,
      })),
      roleSlugs: slugMap(roleIds, PAGE_SIZE),
    });

    expect(ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
    expect(
      recorder.chains.filter((chain) => chain.site === "roles")[0]?.limitArg,
    ).toBe(PAGE_SIZE);
    expect(queriesFor(recorder, "role-assignments")).toBe(2);
  });

  it("resolves all 1,201 role assignments, including the one past the old cap", async () => {
    const total = 1201;
    const roleIds = Array.from({ length: total }, (_row, i) => i + 1);
    expect(total).toBeGreaterThan(OLD_ASSIGNMENT_CAP);

    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      roleAssignments: roleIds.map((roleId) => ({
        id: `ra-${roleId}`,
        roleId,
        expiresAt: null,
      })),
      roleSlugs: slugMap(roleIds, total),
    });

    expect(ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
    expect(
      recorder.chains.filter((chain) => chain.site === "roles")[0]?.limitArg,
    ).toBe(total);
    expect(queriesFor(recorder, "role-assignments")).toBe(3);
  });

  it("carries the group sitting past the old cap into the group-role read", async () => {
    const total = OLD_ASSIGNMENT_CAP + 1;
    const groupIds = Array.from(
      { length: total },
      (_row, i) => `${GROUP_PREFIX}${i + 1}`,
    );
    const lastGroupId = groupIds[total - 1];

    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      groupMemberships: groupIds.map((principalGroupId, index) => ({
        id: `gm-${index + 1}`,
        principalGroupId,
      })),
      groupRolesFor: (observed) =>
        observed.map((_groupId, index) => ({
          id: `gr-${index + 1}`,
          roleId: index + 1,
        })),
      roleSlugs: slugMap(
        Array.from({ length: total }, (_row, i) => i + 1),
        total,
      ),
    });

    expect(ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
    const groupRoleRead = recorder.chains.find(
      (chain) => chain.site === "group-roles",
    );
    expect(groupIdsIn(groupRoleRead?.whereParams ?? [])).toContain(lastGroupId);
    expect(queriesFor(recorder, "group-memberships")).toBe(2);
  });

  it("resolves the group-derived role sitting past the old cap", async () => {
    const total = OLD_ASSIGNMENT_CAP + 1;
    const roleIds = Array.from({ length: total }, (_row, i) => i + 1);

    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      groupMemberships: [{ id: "gm-1", principalGroupId: `${GROUP_PREFIX}1` }],
      groupRolesFor: () =>
        roleIds.map((roleId) => ({ id: `gr-${roleId}`, roleId })),
      roleSlugs: slugMap(roleIds, total),
    });

    expect(ADMIN_ONLY_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
    expect(queriesFor(recorder, "group-roles")).toBe(2);
  });

  it("expands the module ownership sitting past the old cap of 100", async () => {
    const filler = Array.from({ length: OLD_OWNERSHIP_CAP }, (_row, i) => ({
      id: `mo-${i + 1}`,
      moduleKey: SCOPES_NOTHING,
    }));

    const { recorder, perms } = await resolveWith({
      ...emptyFixture(),
      moduleOwnerships: [
        ...filler,
        { id: `mo-${OLD_OWNERSHIP_CAP + 1}`, moduleKey: OWNED_MODULE },
      ],
    });

    expect(queriesFor(recorder, "module-ownerships")).toBe(1);
    expect(OWNED_MODULE_KEYS.filter((key) => perms[key] === undefined)).toEqual(
      [],
    );
  });

  it("stops on the short final page rather than spinning", async () => {
    const roleIds = Array.from({ length: PAGE_SIZE + 1 }, (_row, i) => i + 1);
    const { recorder } = await resolveWith({
      ...emptyFixture(),
      roleAssignments: roleIds.map((roleId) => ({
        id: `ra-${roleId}`,
        roleId,
        expiresAt: null,
      })),
      roleSlugs: slugMap(roleIds, PAGE_SIZE + 1),
    });

    expect(queriesFor(recorder, "role-assignments")).toBe(2);
    expect(recorder.chains.length).toBeLessThan(12);
  });
});
