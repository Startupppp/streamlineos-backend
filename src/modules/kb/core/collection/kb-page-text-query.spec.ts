import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { kbPagePrefixTsQuery } from "./kb-page-text-query";

function render(clause: SQL<unknown>) {
  return new PgDialect().sqlToQuery(clause);
}

describe("kbPagePrefixTsQuery", () => {
  it("builds a prefix term per word, so a half-typed word still matches while the caller is typing", () => {
    const query = kbPagePrefixTsQuery("onbo check");

    expect(query).not.toBeNull();
    const rendered = render(query as SQL<unknown>);
    expect(rendered.sql).toContain("to_tsquery");
    expect(rendered.params).toContain("onbo:* & check:*");
  });

  it("also asks the parser for the untouched query, because stripping punctuation turns ERR-500 into err500 and no document ever produces that lexeme", () => {
    const query = kbPagePrefixTsQuery("ERR-500");

    expect(query).not.toBeNull();
    const rendered = render(query as SQL<unknown>);
    expect(rendered.sql).toContain("plainto_tsquery");
    expect(rendered.params).toContain("ERR-500");
  });

  it("returns null for a query with no letter or digit, so a punctuation-only search matches nothing rather than everything", () => {
    expect(kbPagePrefixTsQuery("!!!")).toBeNull();
    expect(kbPagePrefixTsQuery("   ")).toBeNull();
  });

  it("caps the prefix terms so a pasted paragraph cannot build an unbounded tsquery", () => {
    const query = kbPagePrefixTsQuery(
      "one two three four five six seven eight nine ten",
    );

    expect(query).not.toBeNull();
    const rendered = render(query as SQL<unknown>);
    const prefixTerms = rendered.params.find(
      (param) => typeof param === "string" && param.includes(":*"),
    );
    expect(String(prefixTerms).split(" & ")).toHaveLength(8);
  });
});
