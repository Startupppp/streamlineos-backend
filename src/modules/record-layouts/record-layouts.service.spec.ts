import { BadRequestException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../db/drizzle.types";
import { layoutByKey } from "./record-layout-catalog";
import { RecordLayoutsService, USAGE_SAMPLE_CAP } from "./record-layouts.service";

const dialect = new PgDialect();
const rendered = (fragment: SQL) => dialect.sqlToQuery(fragment);

interface StoredRow {
  adjustmentId: number;
  orgId: string;
  layoutKey: string;
  fieldOrder: string[];
  hiddenFields: string[];
  groups: { title: string; fields: string[] }[];
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A table that answers the way Postgres does, addressed the way the service
 * addresses it.
 *
 * The conditions are RENDERED rather than inspected, so the key a read resolves
 * to is the pair of values the database would actually have been given. A fake
 * that ignored the `where` and returned "the row" would pass every isolation
 * assertion below while proving nothing — which is the failure mode a
 * cross-tenant test exists to rule out.
 */
function makeFakeDb() {
  const rows: StoredRow[] = [];
  const executed: { sql: string; params: unknown[] }[] = [];
  let nextId = 1;

  /** `and(eq(orgId, ?), eq(layoutKey, ?))` renders its two values in order. */
  const addressOf = (condition: SQL): { orgId: string; layoutKey: string } => {
    const { params } = rendered(condition);
    return { orgId: String(params[0]), layoutKey: String(params[1]) };
  };

  const find = (condition: SQL): StoredRow | undefined => {
    const { orgId, layoutKey } = addressOf(condition);
    return rows.find((row) => row.orgId === orgId && row.layoutKey === layoutKey);
  };

  const db = {
    select: () => ({
      from: () => ({
        where: (condition: SQL) => ({
          limit: async () => {
            const row = find(condition);
            return row ? [row] : [];
          },
        }),
      }),
    }),

    insert: () => ({
      values: (value: Omit<StoredRow, "adjustmentId" | "createdAt">) => ({
        onConflictDoUpdate: (config: { set: Partial<StoredRow> }) => ({
          returning: async () => {
            const existing = rows.find(
              (row) => row.orgId === value.orgId && row.layoutKey === value.layoutKey,
            );
            if (existing) {
              Object.assign(existing, config.set);
              return [existing];
            }
            const row: StoredRow = {
              adjustmentId: nextId++,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              ...value,
            };
            rows.push(row);
            return [row];
          },
        }),
      }),
    }),

    delete: () => ({
      where: async (condition: SQL) => {
        const { orgId, layoutKey } = addressOf(condition);
        for (let index = rows.length - 1; index >= 0; index -= 1)
          if (rows[index]!.orgId === orgId && rows[index]!.layoutKey === layoutKey)
            rows.splice(index, 1);
      },
    }),

    execute: async (fragment: SQL) => {
      const query = rendered(fragment);
      executed.push({ sql: query.sql, params: query.params });
      // One row of counts, the shape Postgres returns: `sample` plus `f0..fn`.
      const aliases = [...query.sql.matchAll(/count\(s\."(f\d+)"\)/g)].map((m) => m[1]!);
      return [
        Object.fromEntries([
          ["sample", 40],
          ...aliases.map((alias, index) => [alias, index === 0 ? 40 : 0]),
        ]),
      ];
    },
  } as unknown as Db;

  return { db, rows, executed };
}

const ORG_A = "org_a";
const ORG_B = "org_b";

describe("RecordLayoutsService", () => {
  describe("reading an arrangement", () => {
    it("returns null when the tenant has never arranged anything", async () => {
      const { db } = makeFakeDb();
      await expect(new RecordLayoutsService(db).get(ORG_A, "crm:lead")).resolves.toBeNull();
    });

    it("returns the arrangement in the shape the renderer reads", async () => {
      const { db } = makeFakeDb();
      const service = new RecordLayoutsService(db);
      await service.save(ORG_A, "user_1", "crm:lead", {
        order: ["name", "email"],
        hidden: ["notes"],
        groups: [{ title: "Reach", fields: ["email"] }],
      });

      await expect(service.get(ORG_A, "crm:lead")).resolves.toMatchObject({
        layoutKey: "crm:lead",
        order: ["name", "email"],
        hidden: ["notes"],
        groups: [{ title: "Reach", fields: ["email"] }],
      });
    });

    it("presents an unset arrangement as empty arrays, not as absent keys", async () => {
      const { db } = makeFakeDb();
      const service = new RecordLayoutsService(db);
      await service.save(ORG_A, "user_1", "party", {});

      const stored = await service.get(ORG_A, "party");
      expect(stored).toMatchObject({ order: [], hidden: [], groups: [] });
    });
  });

  describe("tenant scoping", () => {
    it("never reads another organisation's arrangement of the same record type", async () => {
      const { db } = makeFakeDb();
      const service = new RecordLayoutsService(db);
      await service.save(ORG_B, "user_b", "crm:lead", { hidden: ["notes"] });

      await expect(service.get(ORG_A, "crm:lead")).resolves.toBeNull();
    });

    it("writes a row addressed to the caller's organisation and no other", async () => {
      const { db, rows } = makeFakeDb();
      const service = new RecordLayoutsService(db);

      await service.save(ORG_A, "user_a", "crm:lead", { hidden: ["notes"] });
      await service.save(ORG_B, "user_b", "crm:lead", { hidden: ["city"] });

      expect(rows.map((row) => [row.orgId, row.hiddenFields])).toEqual([
        [ORG_A, ["notes"]],
        [ORG_B, ["city"]],
      ]);
    });

    it("a second save replaces the tenant's own row rather than adding one", async () => {
      const { db, rows } = makeFakeDb();
      const service = new RecordLayoutsService(db);

      await service.save(ORG_A, "user_a", "crm:lead", { hidden: ["notes"] });
      await service.save(ORG_A, "user_a", "crm:lead", { hidden: ["city"] });

      expect(rows).toHaveLength(1);
      expect(rows[0]!.hiddenFields).toEqual(["city"]);
    });

    it("deleting one organisation's arrangement leaves the other's standing", async () => {
      const { db } = makeFakeDb();
      const service = new RecordLayoutsService(db);
      await service.save(ORG_A, "user_a", "crm:lead", { hidden: ["notes"] });
      await service.save(ORG_B, "user_b", "crm:lead", { hidden: ["city"] });

      await service.remove(ORG_A, "crm:lead");

      expect(await service.get(ORG_A, "crm:lead")).toBeNull();
      expect(await service.get(ORG_B, "crm:lead")).toMatchObject({ hidden: ["city"] });
    });

    it("records who last saved it", async () => {
      const { db, rows } = makeFakeDb();
      await new RecordLayoutsService(db).save(ORG_A, "user_a", "crm:lead", {});
      expect(rows[0]!.updatedBy).toBe("user_a");
    });

    it("moves updatedAt on a replacing save, which an upsert does not do by itself", async () => {
      const { db } = makeFakeDb();
      const service = new RecordLayoutsService(db);
      const first = await service.save(ORG_A, "user_a", "crm:lead", {});
      await new Promise((resolve) => setTimeout(resolve, 2));
      const second = await service.save(ORG_A, "user_a", "crm:lead", { hidden: ["notes"] });

      expect(second.updatedAt).not.toBe(first.updatedAt);
    });
  });

  describe("validation, which the service refuses to skip", () => {
    it.each(["crm:invoice", "", "../secrets"])(
      "refuses to store an arrangement for %p",
      async (key) => {
        const { db, rows } = makeFakeDb();
        await expect(
          new RecordLayoutsService(db).save(ORG_A, "user_a", key, {}),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(rows).toHaveLength(0);
      },
    );

    it("refuses an unknown layout on delete too, rather than deleting nothing quietly", async () => {
      const { db } = makeFakeDb();
      await expect(
        new RecordLayoutsService(db).remove(ORG_A, "crm:invoice"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("refuses a field the layout does not publish, and stores nothing", async () => {
      const { db, rows } = makeFakeDb();
      await expect(
        new RecordLayoutsService(db).save(ORG_A, "user_a", "crm:lead", { order: ["salary"] }),
      ).rejects.toThrow();
      expect(rows).toHaveLength(0);
    });

    it("refuses to hide the title field even though the request is well-formed", async () => {
      const { db, rows } = makeFakeDb();
      const layout = layoutByKey("crm:lead")!;
      await expect(
        new RecordLayoutsService(db).save(ORG_A, "user_a", "crm:lead", {
          hidden: [layout.titleField],
        }),
      ).rejects.toThrow();
      expect(rows).toHaveLength(0);
    });

    it("refuses to hide a required field", async () => {
      const { db, rows } = makeFakeDb();
      await expect(
        new RecordLayoutsService(db).save(ORG_A, "user_a", "crm:lead", { hidden: ["priority"] }),
      ).rejects.toThrow();
      expect(rows).toHaveLength(0);
    });
  });

  describe("the usage sample", () => {
    it("never reads more than the cap, and says the cap it used", async () => {
      const { db, executed } = makeFakeDb();
      const usage = await new RecordLayoutsService(db).usage(ORG_A, "crm:lead");

      expect(usage.cap).toBe(USAGE_SAMPLE_CAP);
      expect(executed).toHaveLength(1);
      expect(executed[0]!.sql).toContain("LIMIT");
      expect(executed[0]!.params).toContain(USAGE_SAMPLE_CAP);
    });

    it("binds the caller's organisation as a parameter, never as text", async () => {
      const { db, executed } = makeFakeDb();
      await new RecordLayoutsService(db).usage(ORG_A, "crm:lead");

      expect(executed[0]!.params).toContain(ORG_A);
      expect(executed[0]!.sql).not.toContain(ORG_A);
    });

    it("orders the sample, so it is the most recent rows rather than any rows", async () => {
      const { db, executed } = makeFakeDb();
      await new RecordLayoutsService(db).usage(ORG_A, "crm:lead");
      expect(executed[0]!.sql).toContain("ORDER BY");
    });

    it("returns a count for every field it can count", async () => {
      const { db } = makeFakeDb();
      const layout = layoutByKey("crm:lead")!;
      const usage = await new RecordLayoutsService(db).usage(ORG_A, "crm:lead");

      const countable = layout.fields.filter((field) => layout.usage?.columns[field]);
      expect(Object.keys(usage.filled).sort()).toEqual([...countable].sort());
    });

    /**
     * The proposal hides a field whose count is zero. A field with nothing
     * behind it must therefore not be reported as zero, or every computed field
     * in the product would be proposed hidden the first time somebody opened the
     * screen.
     */
    it("names the fields it cannot count instead of reporting them as never filled", async () => {
      const { db } = makeFakeDb();
      const layout = layoutByKey("crm:lead")!;
      const usage = await new RecordLayoutsService(db).usage(ORG_A, "crm:lead");

      for (const field of usage.uncounted) {
        expect(layout.fields).toContain(field);
        expect(usage.filled).not.toHaveProperty(field);
      }
    });

    it("refuses an unknown layout rather than counting nothing", async () => {
      const { db } = makeFakeDb();
      await expect(
        new RecordLayoutsService(db).usage(ORG_A, "crm:invoice"),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
