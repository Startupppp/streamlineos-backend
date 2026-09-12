import { compileQuery } from "./compile";
import { REPORTING_REGISTRY } from "./registry";
import type { QueryDescription } from "./query-description";
import type { QueryRegistry } from "./registry";
import type { DataScope } from "../../access/access.types";

/**
 * The narrowing the compiler applies, and that a description cannot escape.
 *
 * Phase 5 ticket 11. Ticket 10 built a compiler that could not be injected
 * through; this is the other half, and it is a different property: a description
 * that is perfectly well-formed and perfectly safe may still be one the caller
 * is not entitled to run over every row.
 *
 * The distinction the ticket rests on: the organisation predicate and the
 * requester's scope are applied BY THE COMPILER, on the way out, after the
 * description has had its say. If they were something a description supplied,
 * a description could omit them — and "the report that forgot its tenancy
 * predicate" is not a bug you find in review, it is one you find in a support
 * ticket from the wrong customer.
 *
 * So these tests are deliberately adversarial about the description rather than
 * about the compiler's internals. Each one hands `compileQuery` a description
 * built to get out from under the predicate, and asserts the compiled text
 * carries it anyway.
 */

const ORG = "org_11111111";
const USER = "user_22222222";

const requester = (scope: DataScope) => ({ userId: USER, scope });

/**
 * Either spelling of the tenant column, because the schema has both.
 *
 * `deals` says `org_id` and `activities` says `organization_id`, and neither is
 * wrong — the convention changed and the older tables were not renamed. Pinning
 * one spelling here would make this test pass for the sources that happen to use
 * it and fail for the next source somebody registers, which is the opposite of
 * what a coverage test is for.
 */
const TENANT_PREDICATE = /"(org_id|organization_id)"\s*=\s*\$\d+/;
const compile = (description: QueryDescription, scope: DataScope) =>
  compileQuery(description, { organizationId: ORG, requester: requester(scope) });

/** A source that owns its rows, so every scope is expressible over it. */
const ownedSource = (): string => {
  for (const [name, spec] of REPORTING_REGISTRY)
    if (spec.ownership.kind !== "unowned") return name;
  throw new Error("the registry has no owned source; this spec cannot mean anything");
};

/** The least a description can be, so the test is about the predicate and nothing else. */
const simple = (source: string): QueryDescription => ({
  source,
  select: [{ kind: "aggregate", aggregate: "count" }],
  limit: 10,
});

describe("the compiler applies tenancy and scope, not the description", () => {
  it("carries the organisation predicate for every scope, including the widest", () => {
    /*
      `all` is the scope most likely to compile to "no predicate at all" by
      accident, because the scope term legitimately collapses to `true` there.
      The ORGANISATION term is a different term and must survive that collapse —
      a report that is allowed to see everything is allowed to see everything
      belonging to ONE TENANT.
    */
    const scopes: DataScope[] = ["all", "team", "own", "none"];
    for (const scope of scopes) {
      const compiled = compile(simple(ownedSource()), scope);
      expect(compiled.text).toMatch(TENANT_PREDICATE);
      expect(compiled.params).toContain(ORG);
    }
  });

  it("narrows to the requester on `own`, binding the user rather than inlining them", () => {
    const compiled = compile(simple(ownedSource()), "own");

    // The user id must arrive as a bound parameter like every other value. An
    // inlined user id would be the one identifier in the statement that came
    // from caller data, which is exactly the seam ticket 10 closed.
    expect(compiled.params).toContain(USER);
    expect(compiled.text).not.toContain(USER);
  });

  it("returns nothing for `none` rather than everything", () => {
    const compiled = compile(simple(ownedSource()), "none");

    /*
      `none` is what an absent grant resolves to, and it is the direction a scope
      resolution has to fail in. A compiler that treated an unrecognised or
      missing scope as "no narrowing" would hand the whole tenant to precisely
      the caller who was granted nothing.
    */
    expect(compiled.text).toContain("false");
  });

  it("fails closed on a source whose rows nobody owns", () => {
    /*
      Against a fixture registry, deliberately, and the first version of this
      test is the reason why.

      It looked for an unowned source in `REPORTING_REGISTRY` and returned early
      if it found none — and all three registered sources are owned, so it
      returned early every time. It passed while asserting nothing, and went on
      passing when the production code was edited to widen an unowned source to
      `true`. A test that cannot fail is worse than no test: it occupies the
      space where the real one would go.

      Registering an unowned source here means the case exists whatever the
      production registry happens to contain today.
    */
    const registry: QueryRegistry = new Map([
      [
        "orphans",
        {
          table: "orphan_rows",
          organizationColumn: "org_id",
          ownership: { kind: "unowned", reason: "a fixture: these rows belong to nobody" },
          requiredPermission: "crm:deals:read",
          label: "Orphans",
          fields: { id: { column: "id", type: "text", label: "Id" } },
        },
      ],
    ]);

    // A narrowing that cannot be expressed fails closed. "We could not apply
    // your scope, so we ignored it" is the failure this whole module exists to
    // remove, and an unowned source is where it would appear first.
    const compiled = compileQuery(simple("orphans"), {
      organizationId: ORG,
      requester: requester("own"),
      registry,
    });
    expect(compiled.text).toContain("false");
    expect(compiled.text).not.toMatch(/AND\s+true/);
  });

  it("applies the scope to every source in the registry, not a chosen few", () => {
    /*
      The coverage test, and the reason it is worth having: a source added later
      is a source somebody has to remember to narrow. Asserting over the whole
      registry means forgetting is a failing test rather than a quiet hole that
      only the wrong customer ever notices.
    */
    for (const [name, spec] of REPORTING_REGISTRY) {
      const compiled = compile(simple(name), "own");
      expect(compiled.text).toMatch(TENANT_PREDICATE);
      if (spec.ownership.kind !== "unowned") expect(compiled.params).toContain(USER);
    }
  });
});
