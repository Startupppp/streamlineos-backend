import { resolve } from "node:path";
import * as dotenv from "dotenv";

export const CONTROL_PLANE_CELL = "legacy-1";

export function loadEnv() {
  dotenv.config({ path: resolve(process.cwd(), ".env") });
  return process.env;
}

export function envKeyFor(regionKey, suffix) {
  return `REGION_${regionKey.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

export function directUrl(url) {
  if (!url) return url;
  return /-pooler\..*\.neon\.tech/i.test(url) ? url.replace("-pooler.", ".") : url;
}

export function withDatabase(url, database) {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function databaseOf(url) {
  return new URL(url).pathname.replace(/^\//, "");
}

export function redact(url) {
  const parsed = new URL(url);
  parsed.password = "***";
  return parsed.toString();
}

export function parseCellArgs(argv, env) {
  const flag = (name, fallback) => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
  };

  const regionKey = flag("region", "cell-2");
  const cellId = flag("cell", regionKey);
  const database = flag("database", regionKey.replace(/-/g, ""));

  const ownerBase = env.DIRECT_DATABASE_URL || env.DATABASE_URL;
  const appBase = env.APP_DATABASE_URL;

  if (!ownerBase)
    throw new Error("DATABASE_URL (owner role) is required to reach the control plane.");
  if (!appBase)
    throw new Error("APP_DATABASE_URL (the non-BYPASSRLS app role) is required.");

  const configuredOwner = env[envKeyFor(regionKey, "DATABASE_URL")];
  const configuredApp = env[envKeyFor(regionKey, "APP_DATABASE_URL")];

  return {
    regionKey,
    cellId,
    database,
    controlPlane: {
      owner: ownerBase,
      ownerDirect: directUrl(ownerBase),
      app: appBase,
      database: databaseOf(ownerBase),
    },
    cell: {
      owner: configuredOwner ?? withDatabase(ownerBase, database),
      ownerDirect: directUrl(configuredOwner ?? withDatabase(ownerBase, database)),
      app: configuredApp ?? withDatabase(appBase, database),
      database,
    },
    configured: Boolean(configuredOwner && configuredApp),
  };
}

export const CELL_ENV_TEMPLATE = (topology) => [
  `REGION_KEYS=primary,${topology.regionKey}`,
  `${envKeyFor(topology.regionKey, "DATABASE_URL")}=${topology.cell.owner}`,
  `${envKeyFor(topology.regionKey, "APP_DATABASE_URL")}=${topology.cell.app}`,
  `${envKeyFor(topology.regionKey, "CELL_ID")}=${topology.cellId}`,
  `${envKeyFor(topology.regionKey, "DATABASE_SHARD")}=${topology.cellId}`,
  `${envKeyFor(topology.regionKey, "SEARCH_CLUSTER")}=${topology.cellId}`,
];
