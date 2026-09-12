import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import * as dotenv from "dotenv";
import postgres from "postgres";
import type { Db } from "../db/drizzle.types";
import * as schema from "../db/schema";
import { orgPlacementLookup } from "../common/region/placement-lookup";
import { resolvePlacementKeyring } from "../common/region/placement-signature";
import {
  resolveRegionTopology,
  type RegionTopology,
} from "../common/region/region.config";
import {
  ControlPlaneUnavailableError,
  RegionRegistry,
  SignedPlacementRejectedError,
  type OrgRegionLookup,
  type RegionBinding,
} from "../common/region/region-registry";
import type { OrganizationPlacement } from "../common/region/placement";

dotenv.config({ path: resolve(process.cwd(), ".env") });

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
const record = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail });
};

function cellEnv(base: NodeJS.ProcessEnv, regionKey: string): NodeJS.ProcessEnv {
  const prefix = `REGION_${regionKey.toUpperCase().replace(/-/g, "_")}`;
  if (base[`${prefix}_APP_DATABASE_URL`]) return base;

  const appBase = base.APP_DATABASE_URL;
  if (!appBase) throw new PrerequisiteError("APP_DATABASE_URL is required.");

  const url = new URL(appBase);
  url.pathname = `/${regionKey.replace(/-/g, "")}`;

  return {
    ...base,
    REGION_KEYS: `${base.PRIMARY_REGION ?? "primary"},${regionKey}`,
    [`${prefix}_APP_DATABASE_URL`]: url.toString(),
    [`${prefix}_CELL_ID`]: regionKey,
    [`${prefix}_DATABASE_SHARD`]: regionKey,
    [`${prefix}_SEARCH_CLUSTER`]: regionKey,
  };
}

function bind(topology: RegionTopology): {
  bindings: Map<string, RegionBinding>;
  close: () => Promise<void>;
} {
  const bindings = new Map<string, RegionBinding>();
  const clients: postgres.Sql[] = [];

  for (const definition of Object.values(topology.regions)) {
    const client = postgres(definition.databaseUrl, {
      max: 1,
      prepare: false,
      onnotice: () => {},
    });
    clients.push(client);
    bindings.set(definition.key, {
      definition,
      db: drizzle(client, { schema }) as unknown as Db,
    });
  }

  return {
    bindings,
    close: async () => {
      await Promise.all(clients.map((c) => c.end({ timeout: 5 })));
    },
  };
}

function failingAfterFirst(
  real: (orgId: string) => Promise<OrganizationPlacement | null>,
): { lookup: OrgRegionLookup; degrade: () => void } {
  let degraded = false;
  return {
    degrade: () => {
      degraded = true;
    },
    lookup: async (orgId: string) => {
      if (degraded) throw new Error("control plane unreachable (simulated)");
      return real(orgId);
    },
  };
}

async function cellAnswers(binding: RegionBinding, orgId: string): Promise<boolean> {
  const client = postgres(binding.definition.databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => {},
  });
  try {
    return await client.begin(async (tx) => {
      await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;
      const rows = await tx`SELECT id FROM organizations WHERE id = ${orgId}`;
      return rows.length === 1;
    });
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 5 });
  }
}

async function exercise(regionKey: string, orgId: string): Promise<void> {
  const env = cellEnv(process.env, regionKey);
  const topology = resolveRegionTopology(env);
  const keyring = resolvePlacementKeyring(env);
  if (!keyring) throw new Error("no placement signing key; set PLACEMENT_SIGNING_KEY or BACKEND_JWT_SECRET");

  const { bindings, close } = bind(topology);
  const controlPlane = bindings.get(topology.primary);
  if (!controlPlane) throw new Error(`no binding for the primary region "${topology.primary}"`);

  try {
    const real = orgPlacementLookup(controlPlane.db, topology);
    const { lookup, degrade } = failingAfterFirst(real);
    const registry = new RegionRegistry(topology, bindings, lookup, () => Date.now(), keyring);

    const placement = await registry.placementForOrg(orgId);
    record(
      "the organization resolves to the second cell",
      placement.cellId === regionKey && placement.region === regionKey,
      `region=${placement.region} cell=${placement.cellId} v${placement.placementVersion}`,
    );

    const binding = registry.bindingFor(placement.region);
    const servedWhileHealthy = await cellAnswers(binding, orgId);
    record(
      "the second cell serves the organization while the control plane is healthy",
      servedWhileHealthy,
      `queried ${binding.definition.cell.cellId} as the application role with the tenant GUC`,
    );

    const signed = await registry.signedPlacementFor(orgId);
    record(
      "the cached placement is signed",
      typeof signed.token === "string" && signed.token.startsWith("pl1."),
      signed.token ? `token ${signed.token.slice(0, 16)}…` : "no token issued",
    );

    degrade();

    const cachedPlacement = await registry.placementForOrg(orgId);
    record(
      "a placed organization keeps working with the control plane down",
      cachedPlacement.cellId === regionKey,
      `served from the signed cache: cell=${cachedPlacement.cellId} v${cachedPlacement.placementVersion}`,
    );

    const servedWhileDegraded = await cellAnswers(
      registry.bindingFor(cachedPlacement.region),
      orgId,
    );
    record(
      "the second cell still answers with the control plane down",
      servedWhileDegraded,
      "the cell database is reached without a control-plane read",
    );

    const unknownOrg = `unknown-${randomUUID()}`;
    let refusal: unknown = null;
    try {
      await registry.placementForOrg(unknownOrg);
    } catch (error) {
      refusal = error;
    }
    record(
      "an unknown organization is refused rather than guessed",
      refusal instanceof ControlPlaneUnavailableError,
      refusal instanceof Error ? refusal.name : "no error was raised",
    );

    const token = signed.token;
    if (token === null) {
      record("a tampered placement token is rejected", false, "no token was issued to tamper with");
    } else {
      const tampered = `${token.slice(0, -2)}${token.slice(-2) === "aa" ? "bb" : "aa"}`;
      let rejection: unknown = null;
      try {
        registry.acceptSignedPlacement(tampered);
      } catch (error) {
        rejection = error;
      }
      record(
        "a tampered placement token is rejected",
        rejection instanceof SignedPlacementRejectedError,
        rejection instanceof Error ? rejection.message : "the tampered token was accepted",
      );
    }
  } finally {
    await close();
  }
}

function report(): void {
  for (const c of checks)
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(62)} ${c.detail}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\nRESULT: ${failed.length === 0 ? "DEGRADED CONTROL PLANE EXERCISED" : "DEGRADED CONTROL PLANE FAILED"}` +
      ` checks=${checks.length} failed=${failed.length}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

function selfTest(): void {
  checks.length = 0;
  record("an unknown organization is refused rather than guessed", false, "the registry fell back to the primary");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 1) {
    console.log("SELF-TEST PASS: a registry that falls back instead of refusing is reported as a failure");
    return;
  }
  console.error("SELF-TEST FAIL: a fallback did not fail the check");
  process.exitCode = 1;
}

class PrerequisiteError extends Error {
  override readonly name = "PrerequisiteError";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const flag = (name: string, fallback: string): string => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };

  const regionKey = flag("region", "cell-2");
  const orgId = flag("org", "");

  if (!orgId) {
    console.error(
      "PREREQUISITE MISSING: an organization placed in the cell is required: --org=<id>.\n" +
        "Create one with: node src/scripts/place-cell-org.mjs --region=" + regionKey,
    );
    process.exitCode = 2;
    return;
  }

  console.log(`cell: ${regionKey}`);
  console.log(`org : ${orgId}\n`);

  await exercise(regionKey, orgId);
  report();
}

main().catch((e: unknown) => {
  if (e instanceof PrerequisiteError) {
    // Exit 2 is PREREQUISITE UNMET here. Exit 1 would claim a measured violation.
    console.error("PREREQUISITE MISSING:", e.message);
    process.exitCode = 2;
    return;
  }
  console.error("DEGRADED CONTROL PLANE CHECK FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
