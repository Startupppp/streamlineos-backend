import { PgDialect } from "drizzle-orm/pg-core";
import { memberRowReader } from "../../../../test/helpers/membership-state-stub";
import { AccessPermissionResolver } from "../access-permission.resolver";
import { ORG_MEMBER_ROLES } from "../../../common/rbac/org-roles";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-cap-determinism";
const USER = "u-cap-determinism";

const FIXED_CAPS = [500, 100];

interface ChainRecord {
  calls: string[];
  orderByArgs: unknown[];
  limitArg: unknown;
}

interface Recorder {
  chains: ChainRecord[];
  db: Db;
}

function buildRecorder(queue: unknown[][]): Recorder {
  const chains: ChainRecord[] = [];
  let cursor = 0;

  const makeChain = (): Record<string, unknown> => {
    const record: ChainRecord = { calls: [], orderByArgs: [], limitArg: null };
    chains.push(record);
    const link: Record<string, unknown> = {};
    const passthrough = (name: string) => (...args: unknown[]) => {
      record.calls.push(name);
      if (name === "orderBy") record.orderByArgs.push(...args);
      return link;
    };
    link["from"] = passthrough("from");
    link["innerJoin"] = passthrough("innerJoin");
    link["leftJoin"] = passthrough("leftJoin");
    link["where"] = passthrough("where");
    link["orderBy"] = passthrough("orderBy");
    link["limit"] = (...args: unknown[]) => {
      record.calls.push("limit");
      record.limitArg = args[0];
      return Promise.resolve(queue[cursor++] ?? []);
    };
    return link;
  };

  const db = {
    query: {},
    select: () => makeChain(),
    selectDistinct: () => makeChain(),
  } as unknown as Db;

  return { chains, db };
}

function renderOrderBy(args: unknown[]): string {
  const dialect = new PgDialect();
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

async function resolveWithRecorder(): Promise<Recorder> {
  const recorder = buildRecorder([
    [{ roleId: 7, expiresAt: null }],
    [{ principalGroupId: 3 }],
    [],
    [],
    [{ roleId: 9 }],
  ]);

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

  await resolver.computeUserPermissions(ORG, USER, 1);
  return recorder;
}

function cappedChains(recorder: Recorder): ChainRecord[] {
  return recorder.chains.filter(
    (chain) =>
      chain.calls.includes("limit") &&
      typeof chain.limitArg === "number" &&
      FIXED_CAPS.includes(chain.limitArg),
  );
}

describe("bounded access reads are deterministically ordered", () => {
  it("issues seven fixed-cap reads under a non-owner member, so the owner short-circuit is not what is measured", async () => {
    const recorder = await resolveWithRecorder();
    expect(cappedChains(recorder)).toHaveLength(7);
  });

  it("never issues a fixed-cap LIMIT without an ORDER BY applied before it", async () => {
    const recorder = await resolveWithRecorder();
    const capped = cappedChains(recorder);
    expect(capped).toHaveLength(7);

    const unordered = capped.filter((chain) => {
      const orderByIndex = chain.calls.indexOf("orderBy");
      const limitIndex = chain.calls.indexOf("limit");
      return orderByIndex === -1 || orderByIndex > limitIndex;
    });
    expect(unordered.map((chain) => chain.calls)).toEqual([]);
  });

  it("orders the role-assignment, group-membership, module-ownership and group-role reads by a unique column", async () => {
    const recorder = await resolveWithRecorder();
    const joined = cappedChains(recorder)
      .map((chain) => renderOrderBy(chain.orderByArgs))
      .join(" | ");

    expect(joined).toContain("role_assignments");
    expect(joined).toContain("principal_group_members");
    expect(joined).toContain("module_ownerships");
    expect(joined).toContain("group_role_assignments");
  });

  it("renders every fixed-cap ORDER BY as an ascending clause on a concrete column", async () => {
    const recorder = await resolveWithRecorder();
    const rendered = cappedChains(recorder).map((chain) =>
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
      (chain) =>
        chain.calls.includes("limit") &&
        typeof chain.limitArg === "number" &&
        !FIXED_CAPS.includes(chain.limitArg),
    );

    expect(rolesLookup).toHaveLength(1);
    expect(rolesLookup[0]?.limitArg).toBe(2);
    expect(rolesLookup[0]?.orderByArgs).toEqual([]);
  });
});
