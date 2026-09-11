import { PgDialect } from "drizzle-orm/pg-core";
import { nextActiveOrgIdsQuery } from "./next-active-org";

const render = (ids: string[]) => new PgDialect().sqlToQuery(nextActiveOrgIdsQuery(ids));

/**
 * The rendered form is the whole point of this helper, and it is one character away
 * from a shape that fails at runtime rather than at compile time: interpolating the
 * JS array directly renders the row constructor `($1, $2, $3)::text[]`, which
 * Postgres rejects with 42809. Inside a transaction the visible failure is a later
 * statement's 25P02, so the real error surfaces nowhere near this call.
 */
describe("nextActiveOrgIdsQuery renders a real array, not a row constructor", () => {
  it("renders ARRAY[...] with one placeholder per member", () => {
    const query = render(["u1", "u2", "u3"]);

    expect(query.sql).toContain("ARRAY[$1, $2, $3]::text[]");
    expect(query.sql).not.toContain("($1, $2, $3)::text[]");
    expect(query.params).toEqual(["u1", "u2", "u3"]);
  });

  it("parameterises every id rather than inlining it", () => {
    const query = render(["'; DROP TABLE organization_members; --"]);

    expect(query.sql).toContain("ARRAY[$1]::text[]");
    expect(query.sql).not.toContain("DROP TABLE");
    expect(query.params).toEqual(["'; DROP TABLE organization_members; --"]);
  });

  it("calls the SECURITY DEFINER resolver and passes no organisation id", () => {
    const query = render(["u1"]);

    expect(query.sql).toContain("app.next_active_org_ids(");
    expect(query.sql).toContain("user_id");
    expect(query.sql).toContain("next_org_id");
  });

  it("is one statement whatever the cohort size", () => {
    const small = render(["u1"]);
    const large = render(Array.from({ length: 500 }, (_, index) => `u${index}`));

    const statements = (text: string) => text.split(";").filter((part) => part.trim() !== "").length;
    expect(statements(small.sql)).toBe(1);
    expect(statements(large.sql)).toBe(1);
    expect(large.params).toHaveLength(500);
  });
});
