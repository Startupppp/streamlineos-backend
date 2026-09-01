#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SELF_TEST = process.argv.includes("--self-test");

const SCHEMA_PATH = resolve(ROOT, "src", "db", "schema", "common", "feature-flags.ts");

const REQUIRED_COLUMNS = [
  {
    name: "owner",
    description: "Non-nullable text column identifying the team or person responsible for the flag",
    pattern: /text\(["']owner["']\)[^,\n)]*\.notNull\(\)/,
  },
  {
    name: "removalDate / expiresAt (non-nullable)",
    description: "Non-nullable timestamp marking when the flag must be removed",
    pattern: /timestamp\(["'](?:removal_date|expires_at)["']\)[^,\n)]*\.notNull\(\)/,
  },
];

function checkSchema(source) {
  const violations = [];
  for (const col of REQUIRED_COLUMNS) {
    const found = col.pattern.test(source);
    if (!found) {
      violations.push(`Missing non-nullable column: ${col.name}\n  ${col.description}`);
    }
  }
  return violations;
}

if (SELF_TEST) {
  const mockMissingBoth = `
    export const featureFlags = pgTable("feature_flags", {
      id: text("id").primaryKey(),
      key: text("key").notNull().unique(),
      enabled: boolean("enabled").notNull().default(false),
      expiresAt: timestamp("expires_at"),
    });
  `;

  const mockHasBoth = `
    export const featureFlags = pgTable("feature_flags", {
      id: text("id").primaryKey(),
      key: text("key").notNull().unique(),
      enabled: boolean("enabled").notNull().default(false),
      owner: text("owner").notNull(),
      expiresAt: timestamp("expires_at").notNull(),
    });
  `;

  const viols1 = checkSchema(mockMissingBoth);
  if (viols1.length !== 2) {
    process.stderr.write(`SELF-TEST FAILED: expected 2 violations for missing columns, got ${viols1.length}.\n`);
    process.stderr.write(viols1.map((v) => "  " + v).join("\n") + "\n");
    process.exit(1);
  }

  const viols2 = checkSchema(mockHasBoth);
  if (viols2.length !== 0) {
    process.stderr.write(`SELF-TEST FAILED: expected 0 violations for compliant schema, got ${viols2.length}.\n`);
    process.stderr.write(viols2.map((v) => "  " + v).join("\n") + "\n");
    process.exit(1);
  }

  process.stdout.write("SELF-TEST PASSED: feature-flag governance gate correctly detects missing owner and removalDate.\n");
  process.exit(0);
}

let source;
try {
  source = readFileSync(SCHEMA_PATH, "utf8");
} catch {
  process.stderr.write(`[check:feature-flag-governance] Cannot read ${SCHEMA_PATH}\n`);
  process.exit(1);
}

const violations = checkSchema(source);

if (violations.length > 0) {
  process.stderr.write("[check:feature-flag-governance] FAIL — feature_flags schema missing governance columns:\n");
  for (const v of violations) {
    process.stderr.write(`  - ${v}\n`);
  }
  process.stderr.write("\nRequired governance columns for feature flags:\n");
  process.stderr.write("  owner TEXT NOT NULL — team/person responsible; flags with no owner cannot be safely removed\n");
  process.stderr.write("  removal_date TIMESTAMP NOT NULL — flags without a deadline accumulate permanently\n");
  process.stderr.write("\nAction: add these columns to feature-flags.ts and a migration, then re-run.\n");
  process.exit(1);
}

process.stdout.write("[check:feature-flag-governance] OK — feature_flags schema has owner and removal date columns.\n");
