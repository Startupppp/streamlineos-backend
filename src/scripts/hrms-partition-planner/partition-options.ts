import { parseArgs } from "node:util";
import { z } from "zod";
import {
  environmentSchema,
  approvedHashModulus,
  hashPartitionTables,
  monthSchema,
  partitionFamilies,
  partitionTableSchema,
  tenantIdSchema,
  type PartitionEnvironment,
  type PartitionTable,
} from "./partition-config";
import { currentAndNextThree } from "./partition-plan";
import {
  opaqueApprovalIdSchema,
  partitionRoleSchema,
} from "./partition-provenance";

export type PlannerOptions = {
  apply: boolean;
  environment: PartitionEnvironment;
  tables: PartitionTable[];
  months: string[];
  tenantIds: string[];
  hashModulus: number | null;
  manifestPath: string | null;
  manifestSha256: string | null;
  approvalId: string | null;
  applicationRole: string | null;
  migrationRole: string | null;
};

export type ParsedCli =
  | { kind: "help" }
  | { kind: "run"; options: PlannerOptions };

const hashModulusSchema = z.coerce.number().pipe(z.literal(approvedHashModulus));
const hashTableSet = new Set<string>(hashPartitionTables);

function parseCsv(value: string | undefined, label: string): string[] {
  if (value === undefined || value.trim() === "") return [];
  const values = value.split(",").map((item) => item.trim());
  if (values.some((item) => item === ""))
    throw new Error(`${label} contains an empty value`);
  if (new Set(values).size !== values.length)
    throw new Error(`${label} contains duplicate values`);
  return values;
}

function parseTables(value: string | undefined): PartitionTable[] {
  const values = parseCsv(value, "--tables");
  if (values.length === 0) throw new Error("--tables is required");
  return z.array(partitionTableSchema).parse(values);
}

function parseMonths(value: string | undefined): string[] {
  return z.array(monthSchema).parse(parseCsv(value, "--months"));
}

function parseTenants(value: string | undefined): string[] {
  return z.array(tenantIdSchema).max(1000).parse(parseCsv(value, "--tenants"));
}

function resolveMonths(
  rawMonths: string | undefined,
  useCurrentWindow: boolean,
  hasRangeTables: boolean,
  now: Date,
): string[] {
  if (!hasRangeTables) {
    if (rawMonths !== undefined || useCurrentWindow)
      throw new Error("date options apply only to monthly range tables");
    return [];
  }
  if (rawMonths !== undefined && useCurrentWindow)
    throw new Error("choose either --months or --current-next-three");
  if (useCurrentWindow) return currentAndNextThree(now);
  const months = parseMonths(rawMonths);
  if (months.length === 0)
    throw new Error("--months or --current-next-three is required");
  return months.sort();
}

function resolveHashModulus(
  rawModulus: string | undefined,
  hasHashTables: boolean,
): number | null {
  if (!hasHashTables) {
    if (rawModulus !== undefined)
      throw new Error("--hash-modulus applies only to hash tables");
    return null;
  }
  if (rawModulus === undefined)
    throw new Error("--hash-modulus is required for fixed hash tables");
  return hashModulusSchema.parse(rawModulus);
}

export function parseCliOptions(
  args: string[],
  now: Date,
  nodeEnvironment: string | undefined,
): ParsedCli {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    strict: true,
    options: {
      help: { type: "boolean" },
      apply: { type: "boolean" },
      environment: { type: "string" },
      tables: { type: "string" },
      months: { type: "string" },
      tenants: { type: "string" },
      "current-next-three": { type: "boolean" },
      "hash-modulus": { type: "string" },
      manifest: { type: "string" },
      "manifest-sha256": { type: "string" },
      "approval-id": { type: "string" },
      "application-role": { type: "string" },
      "migration-role": { type: "string" },
      "ack-production": { type: "boolean" },
    },
  });
  if (values.help === true) return { kind: "help" };

  const environment = environmentSchema.parse(values.environment);
  const tables = parseTables(values.tables);
  const hasRangeTables = tables.some(
    (table) => partitionFamilies[table].kind === "range",
  );
  const hasHashTables = tables.some((table) => hashTableSet.has(table));
  const months = resolveMonths(
    values.months,
    values["current-next-three"] === true,
    hasRangeTables,
    now,
  );
  const hashModulus = resolveHashModulus(
    values["hash-modulus"],
    hasHashTables,
  );
  const apply = values.apply === true;
  const manifestPath = values.manifest
    ? z.string().trim().min(1).parse(values.manifest)
    : null;
  const manifestSha256 = values["manifest-sha256"]
    ? z.string().regex(/^[a-fA-F0-9]{64}$/).parse(values["manifest-sha256"])
    : null;
  const approvalId = values["approval-id"]
    ? opaqueApprovalIdSchema.parse(values["approval-id"])
    : null;
  const applicationRole = values["application-role"]
    ? partitionRoleSchema.parse(values["application-role"])
    : null;
  const migrationRole = values["migration-role"]
    ? partitionRoleSchema.parse(values["migration-role"])
    : null;

  const manifestParts = [
    manifestPath,
    manifestSha256,
    approvalId,
    applicationRole,
    migrationRole,
  ];
  const suppliedManifestParts = manifestParts.filter(
    (value) => value !== null,
  ).length;
  if (suppliedManifestParts !== 0 && suppliedManifestParts !== 5)
    throw new Error(
      "manifest, hash, approval, application role, and migration role must be supplied together",
    );
  if (apply && manifestPath === null)
    throw new Error("--apply requires --manifest and --manifest-sha256");
  if (nodeEnvironment === "production" && environment !== "production")
    throw new Error("NODE_ENV=production requires --environment=production");
  if (apply && environment === "production" && values["ack-production"] !== true)
    throw new Error("production apply requires --ack-production");
  if (environment !== "production" && values["ack-production"] === true)
    throw new Error("--ack-production is valid only for production");

  return {
    kind: "run",
    options: {
      apply,
      environment,
      tables,
      months,
      tenantIds: parseTenants(values.tenants),
      hashModulus,
      manifestPath,
      manifestSha256,
      approvalId,
      applicationRole,
      migrationRole,
    },
  };
}
