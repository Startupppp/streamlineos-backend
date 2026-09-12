import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { desc, eq } from "drizzle-orm";
import * as dotenv from "dotenv";
import postgres from "postgres";
import type { Db } from "../db/drizzle.types";
import * as schema from "../db/schema";
import { placementDecisions } from "../db/schema";
import {
  CellAdmissionRefusedError,
  chooseRegionForNewOrg,
} from "../common/region/cell-admission";
import { orgPlacementLookup } from "../common/region/placement-lookup";
import { resolvePlacementKeyring } from "../common/region/placement-signature";
import { resolveRegionTopology } from "../common/region/region.config";
import {
  RegionRegistry,
  clearRegionRegistry,
  setRegionRegistry,
  type RegionBinding,
} from "../common/region/region-registry";

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

function selfTest(): void {
  record("a refused admission is recorded, not silently absorbed", false, "no decision row was written");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 1) {
    console.log("SELF-TEST PASS: an unrecorded decision is reported as a failure");
    return;
  }
  console.error("SELF-TEST FAIL: the guard did not fire");
  process.exitCode = 1;
}

class PrerequisiteError extends Error {
  override readonly name = "PrerequisiteError";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) return selfTest();

  const url = process.env.APP_DATABASE_URL;
  if (!url) throw new PrerequisiteError("APP_DATABASE_URL is required (the non-BYPASSRLS app role).");

  const topology = resolveRegionTopology(process.env);
  const keyring = resolvePlacementKeyring(process.env);
  if (!keyring) throw new Error("no placement signing key");

  const client = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(client, { schema }) as unknown as Db;

  const bindings = new Map<string, RegionBinding>();
  for (const definition of Object.values(topology.regions))
    bindings.set(definition.key, { definition, db });

  setRegionRegistry(
    new RegionRegistry(topology, bindings, orgPlacementLookup(db, topology), () => Date.now(), keyring),
  );

  const orgId = `admission-probe-${randomUUID()}`;

  try {
    let refusal: unknown = null;
    let region: string | null = null;

    try {
      region = (await chooseRegionForNewOrg(db, { organizationId: orgId })).region;
    } catch (error) {
      refusal = error;
    }

    const rows = await db
      .select({
        admitted: placementDecisions.admitted,
        selectedCellId: placementDecisions.selectedCellId,
        region: placementDecisions.region,
        rejections: placementDecisions.rejections,
      })
      .from(placementDecisions)
      .where(eq(placementDecisions.organizationId, orgId))
      .orderBy(desc(placementDecisions.decidedAt))
      .limit(1);

    const decision = rows[0];

    record(
      "a decision row is written for every placement attempt",
      decision !== undefined,
      decision ? `admitted=${decision.admitted} cell=${decision.selectedCellId ?? "none"}` : "no row",
    );

    record(
      "the decision is explainable",
      decision !== undefined && Array.isArray(decision.rejections),
      decision ? `rejections=${JSON.stringify(decision.rejections)}` : "no row",
    );

    if (refusal instanceof CellAdmissionRefusedError) {
      record(
        "a full platform refuses visibly rather than placing anyway",
        decision?.admitted === false,
        refusal.message,
      );
    } else {
      record(
        "an admitted placement names the cell it chose",
        region !== null,
        `region=${region ?? "none"} cell=${decision?.selectedCellId ?? "unmeasured fallback"}`,
      );
    }

    await db.delete(placementDecisions).where(eq(placementDecisions.organizationId, orgId));
  } finally {
    clearRegionRegistry();
    await client.end({ timeout: 5 });
  }

  for (const c of checks)
    console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(56)} ${c.detail}`);

  const failed = checks.filter((c) => !c.ok);
  console.log(
    `\nRESULT: ${failed.length === 0 ? "ADMISSION IS LIVE" : "ADMISSION NOT PROVED"}` +
      ` checks=${checks.length} failed=${failed.length}`,
  );
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((e: unknown) => {
  if (e instanceof PrerequisiteError) {
    // Exit 2 is PREREQUISITE UNMET in this repository. Reporting a missing
    // APP_DATABASE_URL as exit 1 claims a violation was measured when nothing ran.
    console.error("PREREQUISITE MISSING:", e.message);
    process.exitCode = 2;
    return;
  }
  console.error("ADMISSION CHECK FAILED:", e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
