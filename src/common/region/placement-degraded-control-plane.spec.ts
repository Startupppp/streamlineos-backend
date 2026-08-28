import { createServer } from "node:net";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { Db } from "../../db/drizzle.types";
import * as schema from "../../db/schema";
import { orgPlacementLookup } from "./placement-lookup";
import type { OrganizationPlacement } from "./placement";
import { resolveRegionTopology } from "./region.config";
import {
  ControlPlaneUnavailableError,
  RegionRegistry,
  clearRegionRegistry,
  type RegionBinding,
} from "./region-registry";
import { resolvePlacementKeyring, type PlacementKeyring } from "./placement-signature";

const topology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
});

const keyring = resolvePlacementKeyring({
  PLACEMENT_SIGNING_KEY: "k".repeat(44),
  PLACEMENT_SIGNING_KEY_ID: "cp-1",
}) as PlacementKeyring;

function placement(orgId: string): OrganizationPlacement {
  return {
    organizationId: orgId,
    region: "eu",
    cellId: "legacy-1",
    databaseShard: "primary",
    objectStorageRegion: "eu",
    searchCluster: "primary",
    placementVersion: 4,
    writeFenceToken: "fence-a",
    leaseExpiresAt: Date.now() + 3_600_000,
    status: "ACTIVE",
  };
}

function bindings(): Map<string, RegionBinding> {
  return new Map(
    Object.values(topology.regions).map((definition) => [
      definition.key,
      { definition, db: {} as Db },
    ]),
  );
}

/**
 * Drizzle wraps the driver error, so the socket code sits a cause link down —
 * and postgres-js builds that inner error in another realm, so `instanceof
 * Error` is false on it. Walking on object-ness is what actually reaches it.
 */
function driverCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return null;
    const code = Reflect.get(current, "code");
    if (typeof code === "string") return code;
    current = Reflect.get(current, "cause");
  }
  return null;
}

/** A port nothing listens on, obtained by opening a server and closing it. */
async function deadPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("no port"));
      else resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("a genuinely unreachable control plane", () => {
  let client: ReturnType<typeof postgres>;
  let unreachableLookup: ReturnType<typeof orgPlacementLookup>;

  beforeAll(async () => {
    const port = await deadPort();
    client = postgres(`postgres://probe:probe@127.0.0.1:${port}/streamlineos`, {
      max: 1,
      prepare: false,
      connect_timeout: 2,
      idle_timeout: 1,
      max_lifetime: 1,
      onnotice: () => {},
    });
    unreachableLookup = orgPlacementLookup(
      drizzle(client, { schema }) as unknown as Db,
      topology,
    );
  });

  afterAll(async () => {
    await client.end({ timeout: 0 }).catch(() => undefined);
  });

  afterEach(() => clearRegionRegistry());

  it("really is a network failure, not a stub — the driver refuses the connection", async () => {
    const error = await unreachableLookup("org-1").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(["ECONNREFUSED", "CONNECT_TIMEOUT", "ECONNRESET"]).toContain(
      driverCode(error),
    );
  }, 20_000);

  it("refuses an organisation with no cached placement rather than guessing a cell", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings(),
      unreachableLookup,
      () => Date.now(),
      keyring,
    );

    await expect(registry.placementForOrg("org-never-seen")).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  }, 20_000);

  it("reports the outage as retryable, so a caller waits rather than failing over", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings(),
      unreachableLookup,
      () => Date.now(),
      keyring,
    );

    const error = await registry
      .placementForOrg("org-never-seen")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ControlPlaneUnavailableError);
    if (!(error instanceof ControlPlaneUnavailableError)) throw new Error("unreachable");
    expect(error.getStatus()).toBe(503);
    const body = error.getResponse() as { code: string; details: Record<string, unknown> };
    expect(body.code).toBe("CONTROL_PLANE_UNAVAILABLE");
    expect(body.details.retryable).toBe(true);
  }, 20_000);

  it("keeps serving an organisation whose signed placement is cached and unexpired", async () => {
    let reachable = true;
    const registry = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) =>
        reachable ? placement(orgId) : unreachableLookup(orgId),
      () => Date.now(),
      keyring,
    );

    await expect(registry.regionForOrg("org-1")).resolves.toBe("eu");

    reachable = false;

    await expect(registry.regionForOrg("org-1")).resolves.toBe("eu");
    await expect(registry.placementForOrg("org-2")).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  }, 20_000);

  it("refuses an expired cached placement instead of renewing it locally", async () => {
    let clock = 1_000_000;
    let reachable = true;
    const registry = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) =>
        reachable ? placement(orgId) : unreachableLookup(orgId),
      () => clock,
      keyring,
    );

    await expect(registry.regionForOrg("org-1")).resolves.toBe("eu");

    reachable = false;
    clock += 11 * 60 * 1000;

    await expect(registry.placementForOrg("org-1")).rejects.toBeInstanceOf(
      ControlPlaneUnavailableError,
    );
  }, 20_000);
});

describe("the signed cache entry", () => {
  afterEach(() => clearRegionRegistry());

  it("is verified on every read, so a tampered entry is treated as absent", async () => {
    let lookups = 0;
    const registry = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => {
        lookups += 1;
        return placement(orgId);
      },
      () => Date.now(),
      keyring,
    );

    await registry.placementForOrg("org-1");
    expect(lookups).toBe(1);

    const entries = Reflect.get(registry, "cache") as Map<string, { token: string }>;
    const entry = entries.get("org-1");
    if (!entry) throw new Error("expected a cached entry");
    entries.set("org-1", { ...entry, token: `${entry.token}x` });

    await registry.placementForOrg("org-1");
    expect(lookups).toBe(2);
  });

  it("hands out a token a cell can verify without the control plane", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => placement(orgId),
      () => Date.now(),
      keyring,
    );

    const { token } = await registry.signedPlacementFor("org-1");
    expect(token).not.toBeNull();

    const verifier = new RegionRegistry(
      topology,
      bindings(),
      async () => {
        throw new Error("the control plane must not be consulted");
      },
      () => Date.now(),
      keyring,
    );

    expect(verifier.acceptSignedPlacement(token ?? "").organizationId).toBe("org-1");
  });

  it("refuses a token signed by a key this cell does not hold", async () => {
    const foreign = resolvePlacementKeyring({
      PLACEMENT_SIGNING_KEY: "z".repeat(44),
      PLACEMENT_SIGNING_KEY_ID: "cp-9",
    }) as PlacementKeyring;

    const issuer = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => placement(orgId),
      () => Date.now(),
      foreign,
    );
    const { token } = await issuer.signedPlacementFor("org-1");

    const verifier = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => placement(orgId),
      () => Date.now(),
      keyring,
    );

    expect(() => verifier.acceptSignedPlacement(token ?? "")).toThrow(
      /could not be trusted/,
    );
  });

  it("refuses a presented placement whose version the cell has already superseded", async () => {
    const issuer = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => ({ ...placement(orgId), placementVersion: 4 }),
      () => Date.now(),
      keyring,
    );
    const { token } = await issuer.signedPlacementFor("org-1");

    const verifier = new RegionRegistry(
      topology,
      bindings(),
      async (orgId) => ({ ...placement(orgId), placementVersion: 9 }),
      () => Date.now(),
      keyring,
    );
    await verifier.placementForOrg("org-1");

    expect(() => verifier.acceptSignedPlacement(token ?? "")).toThrow(
      /could not be trusted/,
    );
  });
});
