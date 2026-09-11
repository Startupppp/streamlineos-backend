import { ALL_PERMISSION_NAMES } from "../../rbac/permissions";
import { isSafeIdentifier } from "./emit";
import { FIELD_TYPES } from "./query-description";
import { BASE_ALIAS, REPORTING_REGISTRY, fieldsOf, joinsOf } from "./registry";

/**
 * The registry is the only source of identifiers, so it is the only place a bad
 * identifier could come from.
 *
 * `quoteIdent` refuses to emit an unsafe name at run time, which turns a bad
 * registry entry into a 500 on one report rather than an injection. That is the
 * safety net. This file is the actual net: it fails the build instead, for every
 * entry at once, before anybody deploys the entry that would have thrown.
 *
 * The permission tests matter just as much. A source whose `requiredPermission`
 * is a key nobody catalogued is a source guarded by a check that can never pass
 * — or, if the resolution ever changed shape, by no check at all. That is the
 * same class of silent failure `gated-keys-are-catalogued.spec.ts` exists for,
 * arriving through a field rather than a decorator, where that spec's regex
 * cannot see it.
 */
describe("the reporting registry", () => {
  const sources = [...REPORTING_REGISTRY.entries()];

  it("declares sources at all", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(sources)("%s emits only names that are safe identifiers", (_key, source) => {
    /**
     * Everything here reaches `quoteIdent`. A name with a quote in it would be
     * refused there; a name with a *space* or an uppercase letter would be
     * refused too, which is the case worth catching early because it looks
     * harmless in a diff.
     */
    expect(isSafeIdentifier(source.table)).toBe(true);
    expect(isSafeIdentifier(source.organizationColumn)).toBe(true);
    if (source.softDeleteColumn) expect(isSafeIdentifier(source.softDeleteColumn)).toBe(true);

    for (const [name, field] of fieldsOf(source)) {
      expect(isSafeIdentifier(field.column)).toBe(true);
      expect(FIELD_TYPES).toContain(field.type);
      /**
       * The caller-facing name is checked too, though it is never emitted. A
       * name containing a dot would be unreachable — `resolveField` would read
       * it as a relation prefix and look for a join that does not exist — so it
       * would be a field that exists in the catalogue and cannot be selected.
       */
      expect(name).not.toContain(".");
      expect(name.length).toBeGreaterThan(0);
    }

    for (const [name, join] of joinsOf(source)) {
      expect(isSafeIdentifier(join.alias)).toBe(true);
      expect(isSafeIdentifier(join.table)).toBe(true);
      expect(isSafeIdentifier(join.organizationColumn)).toBe(true);
      expect(isSafeIdentifier(join.localColumn)).toBe(true);
      expect(isSafeIdentifier(join.foreignColumn)).toBe(true);
      if (join.softDeleteColumn) expect(isSafeIdentifier(join.softDeleteColumn)).toBe(true);
      expect(name).not.toContain(".");
      for (const field of fieldsOf(join).values()) {
        expect(isSafeIdentifier(field.column)).toBe(true);
        expect(FIELD_TYPES).toContain(field.type);
      }
    }
  });

  it.each(sources)("%s gives every join a distinct alias that is not the base", (_key, source) => {
    /**
     * Two joins sharing an alias produce a statement Postgres rejects outright,
     * which is survivable. A join aliased `s` is the dangerous one: it shadows
     * the base table, so `"s"."stage"` silently resolves against the joined
     * relation and the report answers a different question without erroring.
     */
    const aliases = [...joinsOf(source).values()].map((join) => join.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).not.toContain(BASE_ALIAS);
  });

  it.each(sources)("%s is guarded by a permission the catalogue actually has", (_key, source) => {
    /**
     * A source's key is what stops reporting from being a way around the
     * permission that governs the same rows everywhere else. A key absent from
     * the catalogue is never granted to an organisation created after it
     * shipped, so the source would be readable by the tenants that existed when
     * the backfill ran and by nobody since — divergence by signup date, which is
     * the exact failure `0226` and `0232` were written to repair.
     */
    expect(ALL_PERMISSION_NAMES).toContain(source.requiredPermission);
  });

  it("keys the registry by a Map, so a prototype name is a miss", () => {
    /**
     * Stated as a test rather than a comment because the fix is one refactor
     * away from being undone: somebody simplifying `Map` back to a plain object
     * reintroduces `registry["__proto__"]` returning a truthy non-source.
     */
    expect(REPORTING_REGISTRY).toBeInstanceOf(Map);
    for (const name of ["__proto__", "constructor", "prototype", "toString", "valueOf"])
      expect(REPORTING_REGISTRY.get(name)).toBeUndefined();
  });

  it("caches field maps per spec rather than rebuilding them per lookup", () => {
    /**
     * A filter tree resolves one field per node, and the tree is tenant-supplied
     * and bounded at a hundred nodes. Rebuilding the map on each lookup makes
     * resolution quadratic in something a caller controls — cheap here, but it
     * is the shape of a request-driven CPU burn, and the memoisation is easy to
     * drop without noticing.
     */
    const source = REPORTING_REGISTRY.get("deals")!;
    expect(fieldsOf(source)).toBe(fieldsOf(source));
    expect(joinsOf(source)).toBe(joinsOf(source));
  });

  it("soft-deleted tables declare their column, so a report never counts deleted rows", () => {
    /**
     * All three current sources are soft-deleted. Asserting it by name rather
     * than in general because the failure is invisible: a missing
     * `softDeleteColumn` produces a report that runs, returns rows, and includes
     * customers the tenant believes they erased.
     */
    for (const key of ["deals", "activities", "parties"]) {
      expect(REPORTING_REGISTRY.get(key)?.softDeleteColumn).toBe("deleted_at");
    }
  });
});
