import { requireApprovedDatabaseUrl } from "../../src/test/db-spec-guard";
import { assertDisposableDatabase } from "./disposable-database";

export function loadTenantFkProbeConfig(env: NodeJS.ProcessEnv) {
  const url = requireApprovedDatabaseUrl({
    spec: "tenant-relationship-integrity.db.spec.ts",
    vars: ["TENANT_FK_PROBE_DATABASE_URL"],
    env,
  });
  const protocol = new URL(url).protocol;
  if (protocol !== "postgres:" && protocol !== "postgresql:") {
    throw new Error("TENANT_FK_PROBE_DATABASE_URL must use the PostgreSQL protocol");
  }
  const disposable = assertDisposableDatabase(url);
  if (!disposable.ok) throw new Error(disposable.reason);

  function required(suffix: string): string {
    const name = `TENANT_FK_PROBE_${suffix}`;
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required; provide explicit seeded fixture identifiers`);
    return value;
  }
  function id(suffix: string): number {
    const value = required(suffix);
    const parsed = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
      throw new Error(`TENANT_FK_PROBE_${suffix} must be a positive PostgreSQL integer`);
    }
    return parsed;
  }
  const config = {
    url, orgA: required("ORG_A"), orgB: required("ORG_B"),
    projectA: id("PROJECT_A_ID"), projectB: id("PROJECT_B_ID"),
    parentA: id("PARENT_A_ID"), parentB: id("PARENT_B_ID"), childB: id("CHILD_B_ID"),
  };
  if (config.orgA === config.orgB || config.projectA === config.projectB) {
    throw new Error("The FK probe requires two distinct organizations and projects");
  }
  if (new Set([config.parentA, config.parentB, config.childB]).size !== 3) {
    throw new Error("The FK probe requires two distinct parent epics and a separate child ticket");
  }
  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isTicketEpicForeignKeyViolation(error: unknown): boolean {
  let cursor: unknown = error;
  for (let depth = 0; depth < 6 && isRecord(cursor); depth++) {
    if (cursor.code === "23503" && (cursor.constraint_name ?? cursor.constraint) === "fk_tickets_org_epic") {
      return true;
    }
    cursor = cursor.cause;
  }
  return false;
}
