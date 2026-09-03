/**
 * Three list routes coerced `page`/`limit` by hand and handed the result
 * straight to `LIMIT`/`OFFSET`. Postgres rejects both malformed shapes, so the
 * request 500s rather than 400s — and one of them has no upper bound at all.
 *
 * Proven against scratch_head_1010 at journal head:
 *
 *   PREPARE p(bigint) AS SELECT 1 LIMIT $1; EXECUTE p('NaN');
 *     ERROR: invalid input syntax for type bigint: "NaN"   (22P02)
 *   PREPARE q(int)    AS SELECT 1 LIMIT $1; EXECUTE q(-5);
 *     ERROR: LIMIT must not be negative                    (2201W)
 *
 * How each route reached those values:
 *
 *   GET /me/login-history      `Math.min(Number(limit), 100)` — `Number("abc")`
 *                              is NaN and `Math.min(NaN, 100)` is NaN; `Number("-5")`
 *                              is -5 and `Math.min(-5, 100)` is -5. There is no
 *                              lower clamp. `page` had no ceiling either, so
 *                              `?page=1e9&limit=100` computes OFFSET 99,999,999,900
 *                              — an unbounded scan-and-discard on a route marked
 *                              `@Universal()`, i.e. reachable by every
 *                              authenticated user.
 *   GET /support/settings/audit-log
 *                              `Math.min(Number(limit) || 50, 100)` — the `|| 50`
 *                              catches NaN and catches 0, but -5 is truthy and
 *                              passes straight through.
 *   GET /org/members           `Number.parseInt("-5", 10)` is -5, `Number.isFinite(-5)`
 *                              is true, and `Math.min(-5, MAX)` in
 *                              `org-members.service.ts` is -5.
 *
 * The fix is one shared contract, not three hand-written clamps: `pageSizeField`
 * (already on 453 call sites) coerces, floors at 1, rejects a non-number and
 * clamps to the platform cap — and, because it is declared through `@Validate`,
 * the bound also becomes visible in openapi.json instead of living in an
 * expression. This spec pins both halves: the route declares a query schema at
 * all, and the schema answers correctly for each shape that used to 500.
 */
import { z } from "zod";
import type { ValidationSchemas } from "../validation/validate.decorator";
import { VALIDATION_SCHEMAS } from "../validation/validate.decorator";
import { PAGE_SIZE_CAP } from "./list-query.schema";
import { MeController } from "../../me/me.controller";
import { SupportSlaController } from "../../modules/support/core/support-sla.controller";
import { OrgController } from "../../modules/organization/setup/org.controller";

function querySchemaOf(handler: unknown): z.ZodType {
  const schemas: ValidationSchemas | undefined = Reflect.getMetadata(
    VALIDATION_SCHEMAS,
    handler as object,
  );
  const query = schemas?.query;
  if (!query) throw new Error("handler declares no @Validate({ query }) schema");
  return query;
}

/** Every shape that reached Postgres and produced a 500 rather than a 400. */
const HOSTILE_LIMITS = ["abc", "-5", "0", "NaN", "1e400", ""] as const;

describe("list routes that used to hand-coerce page/limit", () => {
  describe("GET /me/login-history", () => {
    const schema = () => querySchemaOf(MeController.prototype.getLoginHistory);

    it("declares a query contract, so the bounds are enforced and documented", () => {
      expect(() => schema()).not.toThrow();
    });

    it.each(HOSTILE_LIMITS)("rejects limit=%p instead of passing it to LIMIT", (limit) => {
      expect(schema().safeParse({ limit }).success).toBe(false);
    });

    it("clamps an over-large limit to the platform cap rather than 400ing a bookmark", () => {
      const parsed = schema().parse({ limit: "5000" });
      expect(parsed).toMatchObject({ limit: PAGE_SIZE_CAP });
    });

    it("bounds page, so OFFSET cannot become a scan-and-discard of 99,999,999,900 rows", () => {
      expect(schema().safeParse({ page: "1000000000" }).success).toBe(false);
      expect(schema().safeParse({ page: "0" }).success).toBe(false);
      expect(schema().safeParse({ page: "-1" }).success).toBe(false);
    });

    it("defaults to the page shape the handler used to hard-code", () => {
      expect(schema().parse({})).toMatchObject({ page: 1, limit: 20 });
    });

    it("still accepts the success filter the route has always taken", () => {
      expect(schema().parse({ success: "true" })).toMatchObject({ success: true });
      expect(schema().parse({ success: "false" })).toMatchObject({ success: false });
      expect(schema().parse({}).success).toBeUndefined();
    });
  });

  describe("GET /support/settings/audit-log", () => {
    const schema = () => querySchemaOf(SupportSlaController.prototype.listSettingsAuditLog);

    it("declares a query contract", () => {
      expect(() => schema()).not.toThrow();
    });

    it.each(HOSTILE_LIMITS)("rejects limit=%p instead of passing it to LIMIT", (limit) => {
      expect(schema().safeParse({ limit }).success).toBe(false);
    });

    it("keeps the route's own default of 50 and clamps above the cap", () => {
      expect(schema().parse({})).toMatchObject({ limit: 50 });
      expect(schema().parse({ limit: "5000" })).toMatchObject({ limit: PAGE_SIZE_CAP });
    });

    it("still narrows entityType to the catalogued set and drops anything else", () => {
      expect(schema().parse({ entityType: "sla_policy" })).toMatchObject({
        entityType: "sla_policy",
      });
      expect(schema().safeParse({ entityType: "not_a_real_entity" }).success).toBe(false);
    });
  });

  describe("GET /org/members", () => {
    const schema = () => querySchemaOf(OrgController.prototype.listMembers);

    it("declares a query contract", () => {
      expect(() => schema()).not.toThrow();
    });

    it.each(HOSTILE_LIMITS)("rejects limit=%p instead of passing it to LIMIT", (limit) => {
      expect(schema().safeParse({ limit }).success).toBe(false);
    });

    it("leaves limit absent when the caller omits it, so the service default still applies", () => {
      expect(schema().parse({}).limit).toBeUndefined();
    });

    it("clamps an over-large limit to the platform cap", () => {
      expect(schema().parse({ limit: "5000" })).toMatchObject({ limit: PAGE_SIZE_CAP });
    });

    it("still accepts the search term", () => {
      expect(schema().parse({ search: "ada" })).toMatchObject({ search: "ada" });
    });
  });
});
