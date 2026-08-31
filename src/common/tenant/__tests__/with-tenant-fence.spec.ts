import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../db/drizzle.types";
import type { OrganizationPlacement } from "../../region/placement";
import { resolveRegionTopology } from "../../region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../../region/region-registry";
import { withTenant, WriteFenceLostError } from "../with-tenant";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
});

const dialect = new PgDialect();

function paramsOf(query: SQL): unknown[] {
  return dialect.sqlToQuery(query).params;
}

function textOf(query: SQL): string {
  return dialect.sqlToQuery(query).sql;
}

function placement(
  overrides: Partial<OrganizationPlacement> = {},
): OrganizationPlacement {
  return {
    organizationId: "org-1",
    region: "eu",
    cellId: "legacy-1",
    databaseShard: "primary",
    objectStorageRegion: "eu",
    searchCluster: "primary",
    placementVersion: 2,
    writeFenceToken: "fence-b",
    leaseExpiresAt: Date.now() + 3_600_000,
    status: "ACTIVE",
    ...overrides,
  };
}

interface CellState {
  placementVersion: number;
  writeFenceToken: string;
}

interface Recorder {
  statements: string[];
  params: unknown[][];
  bodiesRun: number;
}

/**
 * A cell that answers the fence probe from its own state, so a writer routed
 * under a superseded placement version is refused by the database rather than
 * by the test.
 */
function cellDb(state: CellState, recorder: Recorder): Db {
  return {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        execute: async (query: SQL) => {
          const params = paramsOf(query);
          recorder.statements.push(textOf(query));
          recorder.params.push(params);

          const held =
            params.includes(state.writeFenceToken) &&
            params.includes(state.placementVersion);

          return [{ placement_fence_held: held ? 1 : 0 }];
        },
      }),
  } as unknown as Db;
}

function install(resolved: OrganizationPlacement, db: Db): void {
  const bindings = new Map<string, RegionBinding>(
    Object.values(topology.regions).map((definition) => [
      definition.key,
      { definition, db },
    ]),
  );
  setRegionRegistry(new RegionRegistry(topology, bindings, async () => resolved));
}

describe("the write fence in withTenant", () => {
  afterEach(() => clearRegionRegistry());

  it("carries the placement version inside the transaction, not as a connection parameter", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(placement(), cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder));

    await withTenant(
      {} as Db,
      { orgId: "org-1", audience: "INTERNAL", intent: "write" },
      async () => {
        recorder.bodiesRun += 1;
        return "ok";
      },
    );

    const statement = recorder.statements[0] ?? "";
    expect(statement).toContain("app.placement_version");
    expect(statement).toContain("true");
    expect(recorder.params[0]).toContain("2");
    expect(recorder.bodiesRun).toBe(1);
  });

  it("sets the cell id alongside it, so a query can tell which cell it is running in", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(placement(), cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder));

    await withTenant(
      {} as Db,
      { orgId: "org-1", audience: "INTERNAL", intent: "write" },
      async () => "ok",
    );

    expect(recorder.statements[0] ?? "").toContain("app.cell_id");
    expect(recorder.params[0]).toContain("legacy-1");
  });

  it("aborts a write whose placement version the cell no longer fences", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(
      placement({ placementVersion: 1, writeFenceToken: "fence-a" }),
      cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder),
    );

    await expect(
      withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "write" },
        async () => {
          recorder.bodiesRun += 1;
          return "ok";
        },
      ),
    ).rejects.toBeInstanceOf(WriteFenceLostError);

    expect(recorder.bodiesRun).toBe(0);
  });

  it("refuses before the body runs, so a stale router never produces a partial write", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(
      placement({ writeFenceToken: "fence-a" }),
      cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder),
    );

    await expect(
      withTenant({} as Db, { orgId: "org-1", audience: "INTERNAL" }, async () => {
        recorder.bodiesRun += 1;
        return "ok";
      }),
    ).rejects.toBeInstanceOf(WriteFenceLostError);

    expect(recorder.bodiesRun).toBe(0);
  });

  it("reports the failure as retryable with explicit retry information", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(
      placement({ placementVersion: 1, writeFenceToken: "fence-a" }),
      cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder),
    );

    const error = await withTenant(
      {} as Db,
      { orgId: "org-1", audience: "INTERNAL", intent: "write" },
      async () => "ok",
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WriteFenceLostError);
    if (!(error instanceof WriteFenceLostError)) throw new Error("unreachable");
    expect(error.getStatus()).toBe(503);
    const body = error.getResponse() as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe("PLACEMENT_FENCE_LOST");
    expect(body.details.retryable).toBe(true);
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
  });

  it("does not fence a read, so the read path costs nothing extra", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(
      placement({ placementVersion: 1, writeFenceToken: "fence-a" }),
      cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder),
    );

    await expect(
      withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "read" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    expect(recorder.statements[0] ?? "").not.toContain("placement_fence_held");
  });

  it("still carries the placement version on a read, so the GUC is always present", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(placement(), cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder));

    await withTenant(
      {} as Db,
      { orgId: "org-1", audience: "INTERNAL", intent: "read" },
      async () => "ok",
    );

    expect(recorder.statements[0] ?? "").toContain("app.placement_version");
  });

  it("adds no fence probe when placement carries no fence, which is the unit-test path", async () => {
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    install(
      placement({ writeFenceToken: null, leaseExpiresAt: null }),
      cellDb({ placementVersion: 2, writeFenceToken: "fence-b" }, recorder),
    );

    await expect(
      withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "write" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");

    expect(recorder.statements[0] ?? "").not.toContain("placement_fence_held");
  });
});

describe("two concurrent writers under different placement versions", () => {
  afterEach(() => clearRegionRegistry());

  it("commits exactly one of them", async () => {
    const state: CellState = { placementVersion: 2, writeFenceToken: "fence-b" };
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    const db = cellDb(state, recorder);

    const bindings = new Map<string, RegionBinding>(
      Object.values(topology.regions).map((definition) => [
        definition.key,
        { definition, db },
      ]),
    );

    const currentRouter = new RegionRegistry(topology, bindings, async () =>
      placement({ placementVersion: 2, writeFenceToken: "fence-b" }),
    );
    const staleRouter = new RegionRegistry(topology, bindings, async () =>
      placement({ placementVersion: 1, writeFenceToken: "fence-a" }),
    );

    const commits: string[] = [];

    const write = async (router: RegionRegistry, label: string): Promise<void> => {
      setRegionRegistry(router);
      await withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "write" },
        async () => {
          commits.push(label);
          return label;
        },
      );
    };

    const settled = await Promise.allSettled([
      write(currentRouter, "current"),
      write(staleRouter, "stale"),
    ]);

    const fulfilled = settled.filter((r) => r.status === "fulfilled");
    const rejected = settled.filter((r) => r.status === "rejected");

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(commits).toEqual(["current"]);
    expect(
      rejected[0]?.status === "rejected" ? rejected[0].reason : null,
    ).toBeInstanceOf(WriteFenceLostError);
  });

  it("lets the loser through once the cell's own fence advances to its version", async () => {
    const state: CellState = { placementVersion: 1, writeFenceToken: "fence-a" };
    const recorder: Recorder = { statements: [], params: [], bodiesRun: 0 };
    const db = cellDb(state, recorder);

    const bindings = new Map<string, RegionBinding>(
      Object.values(topology.regions).map((definition) => [
        definition.key,
        { definition, db },
      ]),
    );

    setRegionRegistry(
      new RegionRegistry(topology, bindings, async () =>
        placement({ placementVersion: 2, writeFenceToken: "fence-b" }),
      ),
    );

    await expect(
      withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "write" },
        async () => "ok",
      ),
    ).rejects.toBeInstanceOf(WriteFenceLostError);

    state.placementVersion = 2;
    state.writeFenceToken = "fence-b";

    await expect(
      withTenant(
        {} as Db,
        { orgId: "org-1", audience: "INTERNAL", intent: "write" },
        async () => "ok",
      ),
    ).resolves.toBe("ok");
  });
});
