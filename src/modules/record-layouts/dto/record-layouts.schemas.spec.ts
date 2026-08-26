import { layoutByKey, RECORD_LAYOUT_KEYS } from "../record-layout-catalog";
import {
  layoutAdjustmentSchemaFor,
  layoutKeySchema,
  MAX_FIELD_NAMES,
  MAX_GROUPS,
  saveLayoutAdjustmentSchema,
} from "./record-layouts.schemas";

/**
 * The frontend refuses every one of these before it sends a request. None of
 * that reaches a caller holding a bearer token and a shell, which is the only
 * caller this file is about.
 */
describe("record layout adjustment validation", () => {
  const lead = layoutByKey("crm:lead")!;
  const schema = layoutAdjustmentSchemaFor(lead);
  const messages = (result: { success: boolean; error?: { issues: { message: string }[] } }) =>
    (result.error?.issues ?? []).map((issue) => issue.message).join(" | ");

  describe("the layout key", () => {
    it("accepts every published key", () => {
      for (const key of RECORD_LAYOUT_KEYS)
        expect(layoutKeySchema.safeParse(key).success).toBe(true);
    });

    it.each([
      ["a record type nobody renders", "crm:invoice"],
      ["a near miss", "crm:leads"],
      ["a path traversal", "../../etc/passwd"],
      ["SQL", "crm:lead'; DROP TABLE record_layout_adjustments; --"],
      ["empty", ""],
    ])("rejects %s", (_label, key) => {
      expect(layoutKeySchema.safeParse(key).success).toBe(false);
    });
  });

  describe("the body", () => {
    it("accepts an arrangement naming only published fields", () => {
      const result = schema.safeParse({
        order: ["name", "email", "phone"],
        hidden: ["notes"],
        groups: [{ title: "Reach", fields: ["email", "phone"] }],
      });
      expect(result.success).toBe(true);
    });

    it("accepts an empty arrangement — that is a tenant clearing theirs", () => {
      expect(schema.safeParse({}).success).toBe(true);
    });

    /**
     * The organisation and the record type are the caller and the path. A body
     * that could name either would be a second address for one row.
     */
    it.each([
      ["orgId", { orgId: "org_other" }],
      ["organizationId", { organizationId: "org_other" }],
      ["layoutKey", { layoutKey: "crm:deal" }],
      ["updatedAt", { updatedAt: "2026-01-01T00:00:00.000Z" }],
    ])("refuses a body carrying %s", (_label, extra) => {
      expect(saveLayoutAdjustmentSchema.safeParse(extra).success).toBe(false);
    });
  });

  describe("fields must belong to the layout", () => {
    it("rejects an unknown field in order", () => {
      const result = schema.safeParse({ order: ["name", "salary"] });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain('"salary" is not a field of the Lead layout');
    });

    it("rejects an unknown field in hidden", () => {
      const result = schema.safeParse({ hidden: ["salary"] });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("not a field of the Lead layout");
    });

    it("rejects an unknown field inside a group", () => {
      const result = schema.safeParse({
        groups: [{ title: "Mine", fields: ["name", "salary"] }],
      });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("not a field of the Lead layout");
    });

    /**
     * A field belonging to a DIFFERENT published layout is the interesting case:
     * it is a real field name somewhere, so a check that only asked "does this
     * look like a field" would let it through.
     */
    it("rejects a field that belongs to another layout", () => {
      const result = schema.safeParse({ order: ["quoteNumber"] });
      expect(result.success).toBe(false);
    });

    it("reports every unknown field at once, on its own path", () => {
      const result = schema.safeParse({ order: ["salary", "bonus"] });
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join("."))).toEqual([
        "order.0",
        "order.1",
      ]);
    });
  });

  describe("hiding is refused where hiding would break the record", () => {
    it("refuses to hide the title field", () => {
      const result = schema.safeParse({ hidden: ["name"] });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("titles the record");
    });

    it("refuses to hide a required field", () => {
      const result = schema.safeParse({ hidden: ["priority"] });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("would leave the form unsubmittable");
    });

    it("still allows the title field to be REORDERED and grouped", () => {
      // Moving is not hiding. Refusing both would make the title field
      // unarrangeable, which is not what the rule is protecting.
      expect(
        schema.safeParse({
          order: ["name"],
          groups: [{ title: "Identity", fields: ["name"] }],
        }).success,
      ).toBe(true);
    });

    it("refuses the title field of every published layout", () => {
      for (const key of RECORD_LAYOUT_KEYS) {
        const layout = layoutByKey(key)!;
        const result = layoutAdjustmentSchemaFor(layout).safeParse({
          hidden: [layout.titleField],
        });
        expect([key, result.success]).toEqual([key, false]);
      }
    });

    it("refuses every required field of every published layout", () => {
      for (const key of RECORD_LAYOUT_KEYS) {
        const layout = layoutByKey(key)!;
        for (const field of layout.required) {
          const result = layoutAdjustmentSchemaFor(layout).safeParse({ hidden: [field] });
          expect([key, field, result.success]).toEqual([key, field, false]);
        }
      }
    });
  });

  describe("an arrangement cannot be self-contradictory", () => {
    it("rejects a field ordered twice", () => {
      const result = schema.safeParse({ order: ["name", "email", "name"] });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("cannot put one field in two places");
    });

    it("rejects a field placed in two groups", () => {
      const result = schema.safeParse({
        groups: [
          { title: "A", fields: ["email"] },
          { title: "B", fields: ["email"] },
        ],
      });
      expect(result.success).toBe(false);
      expect(messages(result)).toContain("more than one group");
    });
  });

  describe("an arrangement is bounded", () => {
    it("rejects more field names than any layout could hold", () => {
      const result = schema.safeParse({
        order: Array.from({ length: MAX_FIELD_NAMES + 1 }, () => "name"),
      });
      expect(result.success).toBe(false);
    });

    it("rejects more groups than a screen could show", () => {
      const result = schema.safeParse({
        groups: Array.from({ length: MAX_GROUPS + 1 }, (_v, i) => ({
          title: `G${i}`,
          fields: [],
        })),
      });
      expect(result.success).toBe(false);
    });

    it("rejects an empty group title", () => {
      expect(schema.safeParse({ groups: [{ title: "   ", fields: [] }] }).success).toBe(false);
    });
  });
});
