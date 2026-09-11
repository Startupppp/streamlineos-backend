import { compileQuery } from "../../reporting/compiler/compile";
import { QueryCompilationError } from "../../reporting/compiler/errors";
import type { FilterNode } from "../../reporting/compiler/query-description";
import { CRM_PERMISSIONS } from "../../rbac/permissions/crm";
import { PARTY_PERMISSIONS } from "../../rbac/permissions/party";
import {
  SEGMENT_MANAGE,
  SEGMENT_MEMBER_PREVIEW_MAX,
  SEGMENT_VIEW,
  UnsegmentableSourceError,
  buildCountQuery,
  buildMemberQuery,
  decideSegmentSourceAccess,
  describeSegmentSources,
  isSegmentableSource,
} from "./segment-query";

/**
 * What this file is trying to break.
 *
 * Segments have no query engine — they build descriptions for the reporting
 * compiler. That makes exactly two things worth attacking here, and they are not
 * the compiler's own safety, which has its own adversarial suites.
 *
 * The first is **admission**: does holding the segment key, and only the segment
 * key, get anybody to a party row? The second is **the descriptions this module
 * emits**: they are assembled from string field *names*, and a name this module
 * gets wrong must be a refusal rather than a widening. Both are asserted against
 * the real registry and the real compiler, because a fixture registry would
 * prove these functions agree with a fixture.
 */

const PARTY_SOURCE_KEY = "party:parties:view";

const CRITERIA: FilterNode = {
  kind: "and",
  nodes: [
    { kind: "compare", field: "industry", operator: "eq", value: "Textiles" },
    { kind: "compare", field: "lifecycle_stage", operator: "ne", value: "CHURNED" },
  ],
};

const held = (...keys: string[]): ReadonlySet<string> => new Set(keys);

const compileAsAdmin = (description: ReturnType<typeof buildCountQuery>) =>
  compileQuery(description, {
    organizationId: "org_alpha",
    requester: { userId: "user_one", scope: "all" },
  });

describe("who may evaluate a segment", () => {
  it("refuses the segment key alone as a way into the rows", () => {
    /**
     * The module's whole safety argument. `crm:segments:view` says a person may
     * work with segments; it says nothing about which data. Without the key that
     * governs parties everywhere else, a segment must not become the way to
     * count and list the customers whose own screen refuses you.
     */
    expect(decideSegmentSourceAccess("parties", held(SEGMENT_VIEW))).toEqual({
      allowed: false,
      missing: PARTY_SOURCE_KEY,
    });
  });

  it("refuses the source key alone", () => {
    expect(decideSegmentSourceAccess("parties", held(PARTY_SOURCE_KEY))).toEqual({
      allowed: false,
      missing: SEGMENT_VIEW,
    });
  });

  it("admits a caller holding both", () => {
    expect(
      decideSegmentSourceAccess("parties", held(SEGMENT_VIEW, PARTY_SOURCE_KEY)),
    ).toEqual({ allowed: true });
  });

  it("does not accept the authoring key in place of the reading one", () => {
    /**
     * `manage` authors; it does not admit rows. A grant of `manage` without
     * `view` is odd but expressible, and it must not evaluate anything — the
     * alternative is an authoring key that quietly reads.
     */
    expect(
      decideSegmentSourceAccess("parties", held(SEGMENT_MANAGE, PARTY_SOURCE_KEY)),
    ).toEqual({ allowed: false, missing: SEGMENT_VIEW });
  });

  it("refuses a registry source that is not segmentable, with no key to ask for", () => {
    /**
     * `deals` is in the reporting registry and is deliberately not segmentable.
     * The absent `missing` is the load-bearing half: there is no permission that
     * would grant this, so the service answers 400 rather than sending somebody
     * to an administrator who cannot help.
     */
    expect(
      decideSegmentSourceAccess("deals", held(SEGMENT_VIEW, "crm:deals:read")),
    ).toEqual({ allowed: false, missing: undefined });
    expect(isSegmentableSource("deals")).toBe(false);
    expect(isSegmentableSource("activities")).toBe(false);
  });

  it("misses on prototype names like any other unknown source", () => {
    /**
     * A plain object lookup returns something truthy for these, which a naive
     * existence check treats as found. The source map is a `Map` for the reason
     * the registry is one.
     */
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"])
      expect(decideSegmentSourceAccess(name, held(SEGMENT_VIEW, PARTY_SOURCE_KEY))).toEqual({
        allowed: false,
        missing: undefined,
      });
  });
});

describe("the criteria vocabulary a caller is shown", () => {
  it("discloses nothing to a caller who could not evaluate it", () => {
    /**
     * Filtered, not annotated. A source listed with a `canRead: false` beside it
     * still tells the caller that parties exist, what their fields are called,
     * and therefore what the tenant stores.
     */
    expect(describeSegmentSources(held(SEGMENT_VIEW))).toEqual([]);
    expect(describeSegmentSources(held(PARTY_SOURCE_KEY))).toEqual([]);
  });

  it("offers parties and nothing else", () => {
    const described = describeSegmentSources(held(SEGMENT_VIEW, PARTY_SOURCE_KEY));
    expect(described.map((source) => source.key)).toEqual(["parties"]);
  });

  it("flattens a relation into dotted names the compiler resolves verbatim", () => {
    const [parties] = describeSegmentSources(held(SEGMENT_VIEW, PARTY_SOURCE_KEY));
    expect(parties).toBeDefined();
    if (!parties) return;

    const names = parties.fields.map((field) => field.name);
    expect(names).toContain("industry");
    expect(names).toContain("lifecycle_stage");

    /**
     * Every offered name has to be one the compiler will accept, or the builder
     * is teaching people to write criteria that 400. Asserted by compiling one
     * criterion per offered field rather than by comparing two lists, because
     * two lists can agree and both be wrong.
     */
    for (const field of parties.fields) {
      const description = buildCountQuery("parties", {
        kind: "compare",
        field: field.name,
        operator: "is_not_null",
      });
      expect(() => compileAsAdmin(description)).not.toThrow();
    }
  });
});

describe("the descriptions this module emits", () => {
  it("projects the source's identity fields and orders by the first of them", () => {
    const description = buildMemberQuery("parties", CRITERIA, 25);

    expect(description.source).toBe("parties");
    expect(description.select[0]).toEqual({ kind: "field", field: "name" });
    /**
     * `SortSpec.select` is an index into `select`, never a field name — the
     * compiler refuses to sort by a column the caller did not project, because
     * repeated queries ordered by an unseen column reconstruct it.
     */
    expect(description.orderBy).toEqual([{ select: 0, direction: "asc" }]);
    expect(description.filter).toBe(CRITERIA);
  });

  it("never offers an offset, because no source publishes a row identifier", () => {
    /**
     * The absence is the assertion. An offset over an ordering that is not
     * unique repeats and skips rows between pages the moment anything is
     * written, and on a "who is in this segment" screen that reads as the
     * segment changing under the reader.
     */
    expect(buildMemberQuery("parties", CRITERIA, 25).offset).toBeUndefined();
  });

  it("clamps the sample to the preview bound in both directions", () => {
    expect(buildMemberQuery("parties", CRITERIA, 10_000).limit).toBe(
      SEGMENT_MEMBER_PREVIEW_MAX,
    );
    expect(buildMemberQuery("parties", CRITERIA, 0).limit).toBe(1);
    expect(buildMemberQuery("parties", CRITERIA, -5).limit).toBe(1);
  });

  it("counts with one ungrouped aggregate, so a size cannot saturate at the sample", () => {
    const description = buildCountQuery("parties", CRITERIA);
    expect(description.select).toEqual([{ kind: "aggregate", aggregate: "count" }]);
    expect(description.groupBy).toBeUndefined();
    expect(compileAsAdmin(description).columns).toHaveLength(1);
  });

  it("refuses an unsegmentable source before anything is built", () => {
    expect(() => buildMemberQuery("deals", CRITERIA, 10)).toThrow(UnsegmentableSourceError);
    expect(() => buildCountQuery("deals", CRITERIA)).toThrow(UnsegmentableSourceError);
  });
});

describe("what the compiler does with them", () => {
  it("emits the tenant predicate and no criterion value", () => {
    const compiled = compileAsAdmin(buildMemberQuery("parties", CRITERIA, 25));

    expect(compiled.text).toContain('"business_parties"');
    expect(compiled.text).toContain('"organization_id" = $1');
    /**
     * The values a tenant typed are bind parameters and appear nowhere in the
     * statement. This is the property the whole reuse rests on, restated here so
     * a change to how this module assembles a description cannot quietly lose
     * it.
     */
    expect(compiled.text).not.toContain("Textiles");
    expect(compiled.text).not.toContain("CHURNED");
    expect(compiled.text).not.toContain("'");
    expect(compiled.params).toContain("Textiles");
  });

  it("excludes soft-deleted parties without the criteria saying so", () => {
    /**
     * A deleted customer appearing in a segment is a privacy incident rather
     * than a bug, and no stored criteria tree has to remember to say so — the
     * registry declares the soft-delete column and the compiler appends it.
     */
    expect(compileAsAdmin(buildMemberQuery("parties", CRITERIA, 25)).text).toContain(
      '"deleted_at" IS NULL',
    );
  });

  it("narrows a scoped requester, whatever the stored criteria said", () => {
    const narrowed = compileQuery(buildMemberQuery("parties", CRITERIA, 25), {
      organizationId: "org_alpha",
      requester: { userId: "user_one", scope: "own" },
    });

    /**
     * The scope term is appended after the stored criteria by conjunction, so
     * there is no `or` a segment author could have written that reaches outside
     * it. A segment saved by an administrator and opened by a narrowed rep
     * returns the rep's rows.
     */
    expect(narrowed.text).toContain('"owner_user_id" = ');
    expect(narrowed.scope).toBe("own");
    expect(narrowed.params).toContain("user_one");
  });

  it("re-validates a stored criterion against today's registry", () => {
    /**
     * A stored tree is older than the compiler that runs it. A criterion naming
     * a field withdrawn from the registry since it was saved has to fail loudly
     * rather than compile to something adjacent — which is why nothing here
     * trusts that a description was valid when it was written.
     */
    const withdrawn: FilterNode = {
      kind: "compare",
      field: "tax_number",
      operator: "eq",
      value: "AAAAA0000A",
    };

    expect(() => compileAsAdmin(buildCountQuery("parties", withdrawn))).toThrow(
      QueryCompilationError,
    );
  });
});

describe("the keys these gates name", () => {
  it("exists in the catalogue, so a gate is not a permission nobody mints", () => {
    /**
     * A key gated on a route and absent from the catalogue answers for every
     * organisation that existed when a backfill ran and 403s for every one
     * created afterwards, silently. Asserted against the real catalogue rather
     * than a list, so deleting the entry fails here.
     */
    const catalogued = new Set(CRM_PERMISSIONS.map((permission) => permission.name));
    expect(catalogued.has(SEGMENT_VIEW)).toBe(true);
    expect(catalogued.has(SEGMENT_MANAGE)).toBe(true);

    const partyKeys = new Set(PARTY_PERMISSIONS.map((permission) => permission.name));
    expect(partyKeys.has(PARTY_SOURCE_KEY)).toBe(true);
  });

  it("hands the reading key to every CRM member, and the authoring key to nobody by naming", () => {
    /**
     * `buildModuleMemberPermissionKeys` gives a module's members every key
     * ending `:view` or `:read`. That is intended for `crm:segments:view`,
     * because it discloses nothing the party screen does not — the party key is
     * required on top of it. It must NOT be true of the authoring key, and the
     * suffix is the only thing that decides.
     */
    expect(SEGMENT_VIEW.endsWith(":view")).toBe(true);
    expect(SEGMENT_MANAGE.endsWith(":view") || SEGMENT_MANAGE.endsWith(":read")).toBe(false);
  });
});
