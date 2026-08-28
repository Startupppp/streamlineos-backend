import { FaultServer, refusedPort } from "./fault-server";
import {
  RegionRegistry,
  ControlPlaneUnavailableError,
  type RegionBinding,
} from "../common/region/region-registry";
import { resolveRegionTopology, type RegionTopology } from "../common/region/region.config";
import type { Db } from "../db/drizzle.types";

const topology: RegionTopology = resolveRegionTopology({
  PRIMARY_REGION: "eu",
  REGION_KEYS: "eu",
  REGION_EU_APP_DATABASE_URL: "postgres://eu/main",
});

const fakeDb = { __tag: "db" } as unknown as Db;

const bindings: ReadonlyMap<string, RegionBinding> = new Map([
  [
    "eu",
    {
      definition: topology.regions["eu"]!,
      db: fakeDb,
    },
  ],
]);

describe("Control plane degraded — lookup throws", () => {
  it("wraps the transport error in ControlPlaneUnavailableError rather than falling back to primary", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings,
      async () => { throw new Error("connection refused"); },
    );

    await expect(registry.regionForOrg("org-1")).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });

  it("the ControlPlaneUnavailableError is retryable and carries the orgId", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings,
      async () => { throw new Error("timeout"); },
    );

    const err = await registry.regionForOrg("org-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ControlPlaneUnavailableError);
    const typed = err as ControlPlaneUnavailableError;
    const body = typed.getResponse() as Record<string, unknown>;
    expect(body["details"]).toMatchObject({ retryable: true });
    expect(String(body["message"])).toContain("org-1");
  });

  it("does not cache a failed lookup — the next call retries the control plane", async () => {
    let calls = 0;
    const registry = new RegionRegistry(
      topology,
      bindings,
      async () => {
        calls++;
        throw new Error("control plane down");
      },
    );

    await expect(registry.regionForOrg("org-1")).rejects.toThrow();
    await expect(registry.regionForOrg("org-1")).rejects.toThrow();

    expect(calls).toBe(2);
  });
});

describe("Control plane degraded — lookup returns 503 (simulated via fault server)", () => {
  let server: FaultServer;

  beforeAll(async () => {
    server = new FaultServer({ mode: "error", statusCode: 503 });
    await server.start();
  });

  afterAll(() => server.stop());

  it("a lookup that fetches from a 503 endpoint wraps the failure in ControlPlaneUnavailableError", async () => {
    const faultUrl = server.url;
    const lookup = async (_orgId: string) => {
      const res = await fetch(faultUrl);
      if (!res.ok) throw new Error(`control plane returned ${res.status}`);
      return (await res.json()) as string;
    };

    const registry = new RegionRegistry(topology, bindings, lookup);

    await expect(registry.regionForOrg("org-1")).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});

describe("Control plane degraded — lookup endpoint REFUSED (no listener)", () => {
  it("a lookup that connects to a refused port wraps the ECONNREFUSED in ControlPlaneUnavailableError", async () => {
    const port = await refusedPort();
    const lookup = async (_orgId: string) => {
      const res = await fetch(`http://127.0.0.1:${port}`);
      return (await res.json()) as string;
    };

    const registry = new RegionRegistry(topology, bindings, lookup);

    await expect(registry.regionForOrg("org-1")).rejects.toBeInstanceOf(ControlPlaneUnavailableError);
  });
});

describe("Control plane degraded — stale or unknown placement refused", () => {
  it("refuses an org placed in a region this deployment does not serve", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings,
      async () => "ap",
    );

    await expect(registry.regionForOrg("org-1")).rejects.toThrow(/does not serve/);
  });

  it("refuses an org nobody has placed rather than guessing the primary", async () => {
    const registry = new RegionRegistry(
      topology,
      bindings,
      async () => null,
    );

    await expect(registry.regionForOrg("org-1")).rejects.toThrow(/has no region/);
  });
});
