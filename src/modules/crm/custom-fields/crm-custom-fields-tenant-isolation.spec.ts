import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { CrmCustomFieldsService } from "./crm-custom-fields.service";
import { CRM_CUSTOM_FIELD_ENTITY_TYPES } from "./dto/crm-custom-fields.schemas";
import type { CustomFieldsListInput } from "./dto/crm-custom-fields.schemas";

function sqlValues(v: unknown, seen = new Set<object>()): unknown[] {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return [v];
  if (Array.isArray(v)) return v.flatMap(i => sqlValues(i, seen));
  if (typeof v !== "object" || seen.has(v)) return [];
  seen.add(v);
  const r = v as { queryChunks?: unknown[]; value?: unknown };
  return [...(r.queryChunks ? sqlValues(r.queryChunks, seen) : []), ...(Object.prototype.hasOwnProperty.call(r, "value") ? sqlValues(r.value, seen) : [])];
}

describe("CrmCustomFieldsService — cross-tenant isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeDb(wheres: unknown[]) {
    return {
      select: jest.fn().mockImplementation(() => ({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation((a: unknown) => {
            wheres.push(a);
            return Object.assign(Promise.resolve([]), {
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockResolvedValue([]),
              }),
            });
          }),
        }),
      })),
    } as unknown as Db;
  }

  const LIST: CustomFieldsListInput = { limit: 50 };

  it("scopes custom field list to the requesting org (tenant isolation)", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmCustomFieldsService(makeDb(wheres));

    await svc.listCustomFields(ATTACKER, LIST);

    expect(wheres.length).toBeGreaterThan(0);
    const vals = wheres.flatMap(w => sqlValues(w));
    expect(vals).toContain(ATTACKER);
    expect(vals).not.toContain(OWNER);
  });

  it("returns custom fields for the owning org (same-tenant control)", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmCustomFieldsService(makeDb(wheres));

    const result = await svc.listCustomFields(OWNER, LIST);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("fields");
    expect(Array.isArray(result.fields)).toBe(true);
  });
});

/**
 * The second boundary on the same table.
 *
 * `custom_field_definitions` serves Support (`ticket`), HR (`employee`) and
 * Build as well as CRM, and each of those constrains its own reads and writes to
 * its own `entityType`. This route did not: `updateCustomField` and
 * `deleteCustomField` took a bare id and keyed on `(id, org_id)`, so the holder
 * of a global settings key could rename or drop another module's definition
 * inside their own tenant. Same-tenant, wrong module — which no cross-tenant
 * test can see.
 */
describe("CrmCustomFieldsService — cross-module containment", () => {
  const ORG = "org-1";
  const FOREIGN_ENTITY_TYPES = ["ticket", "employee", "project"];

  function recordingDb(wheres: unknown[], rows: unknown[] = []) {
    const where = jest.fn().mockImplementation((clause: unknown) => {
      wheres.push(clause);
      return Object.assign(Promise.resolve(rows), {
        limit: jest.fn().mockResolvedValue(rows),
        returning: jest.fn().mockResolvedValue(rows),
        orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
      });
    });
    return {
      select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where }) }),
      update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
      delete: jest.fn().mockReturnValue({ where }),
    } as unknown as Db;
  }

  it("names the owned entity types on an update, and no foreign one", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmCustomFieldsService(recordingDb(wheres));

    await expect(svc.updateCustomField(ORG, 7, { label: "x" })).rejects.toThrow(
      NotFoundException,
    );

    const vals = wheres.flatMap((w) => sqlValues(w));
    expect(CRM_CUSTOM_FIELD_ENTITY_TYPES.every((t) => vals.includes(t))).toBe(true);
    for (const foreign of FOREIGN_ENTITY_TYPES) expect(vals).not.toContain(foreign);
  });

  it("names the owned entity types on a delete", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmCustomFieldsService(recordingDb(wheres));

    await expect(svc.deleteCustomField(ORG, 7)).rejects.toThrow(NotFoundException);

    const vals = wheres.flatMap((w) => sqlValues(w));
    expect(CRM_CUSTOM_FIELD_ENTITY_TYPES.every((t) => vals.includes(t))).toBe(true);
  });

  it("bounds the unfiltered list to the owned entity types too", async () => {
    const wheres: unknown[] = [];
    const svc = new CrmCustomFieldsService(recordingDb(wheres));

    await svc.listCustomFields(ORG, { limit: 50 });

    const vals = wheres.flatMap((w) => sqlValues(w));
    expect(CRM_CUSTOM_FIELD_ENTITY_TYPES.every((t) => vals.includes(t))).toBe(true);
  });

  it("a foreign definition is a 404, never a 403 — the id must not be confirmable", async () => {
    const svc = new CrmCustomFieldsService(recordingDb([]));

    await expect(svc.updateCustomField(ORG, 7, { label: "x" })).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.deleteCustomField(ORG, 7)).rejects.not.toThrow(
      ForbiddenException,
    );
  });
});
