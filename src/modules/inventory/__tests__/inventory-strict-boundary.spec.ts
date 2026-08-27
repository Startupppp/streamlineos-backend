/**
 * INV-102 — every inventory boundary schema rejects unknown keys.
 *
 * Zod strips by default, so before this the module's 125 object schemas
 * silently discarded any key they did not declare. A client sending `orgId`,
 * `createdBy` or `quantityAfter` got a 2xx and no indication that the field had
 * been dropped, which is the exact failure the PRD forbids: never silently
 * strip a client-sent protected field.
 *
 * This walks the real DTO tree rather than a hand-kept list, so a schema added
 * later without `.strict()` fails here instead of shipping.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const DTO_ROOT = join(__dirname, "..");

function dtoModulePaths(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\/dto\/.*\.ts$/.test(path) || /\.schemas?\.ts$/.test(path)) found.push(path);
    }
  };
  walk(DTO_ROOT);
  return found.sort();
}

interface ExportedSchema {
  module: string;
  name: string;
  schema: z.ZodObject;
}

function isZodObject(value: unknown): value is z.ZodObject {
  return value instanceof z.ZodObject;
}

function exportedObjectSchemas(): ExportedSchema[] {
  const out: ExportedSchema[] = [];
  for (const path of dtoModulePaths()) {
    const loaded: unknown = require(path);
    if (typeof loaded !== "object" || loaded === null) continue;
    for (const [name, value] of Object.entries(loaded as Record<string, unknown>))
      if (isZodObject(value)) out.push({ module: path.replace(DTO_ROOT + "/", ""), name, schema: value });
  }
  return out;
}

/** Server-owned fields a client must never be able to assert. */
const PROTECTED_FIELDS = [
  "orgId",
  "organizationId",
  "createdBy",
  "actorId",
  "userId",
  "approvedBy",
  "approvedAt",
  "quantityBefore",
  "quantityAfter",
  "availableQty",
  "averageCost",
  "createdAt",
  "updatedAt",
  "postedAt",
] as const;

describe("inventory boundary schemas", () => {
  const schemas = exportedObjectSchemas();

  it("finds the whole DTO surface", () => {
    expect(schemas.length).toBeGreaterThanOrEqual(60);
  });

  it.each(schemas.map((s) => [`${s.module}#${s.name}`, s.schema] as const))(
    "%s rejects unknown keys",
    (_label, schema) => {
      expect(schema._zod.def.catchall?._zod.def.type).toBe("never");
    },
  );

  it("rejects every protected field a schema does not itself declare", () => {
    const accepted: string[] = [];
    for (const { module, name, schema } of schemas) {
      const declared = new Set(Object.keys(schema.shape));
      for (const field of PROTECTED_FIELDS) {
        if (declared.has(field)) continue;
        const result = schema.safeParse({ [field]: "injected" });
        // A schema with required fields fails for missing ones too; what matters
        // is that the unrecognised key is among the reported issues.
        const flagged =
          !result.success &&
          result.error.issues.some(
            (issue) => issue.code === "unrecognized_keys" && issue.keys.includes(field),
          );
        if (!flagged) accepted.push(`${module}#${name}.${field}`);
      }
    }
    expect(accepted).toEqual([]);
  });
});
