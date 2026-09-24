import { PgDialect } from "drizzle-orm/pg-core";
import { metadataSearch, searchTerms } from "./kb-linked-document-search";

const dialect = new PgDialect();
const render = (input: NonNullable<ReturnType<typeof metadataSearch>>["match"]) => dialect.sqlToQuery(input);

describe("searchTerms", () => {
  it("keeps the words of a sentence, lower-cased and de-duplicated, and drops single characters", () => {
    expect(searchTerms("How many DAYS of leave do I get? Leave!")).toEqual(["how", "many", "days", "of", "leave", "do", "get"]);
  });

  it("keeps letters and digits from any script and nothing else", () => {
    expect(searchTerms("Gehalt für März 2026 – 薪資")).toEqual(["gehalt", "für", "märz", "2026", "薪資"]);
  });

  it("strips every character that means something to a text-search query", () => {
    expect(searchTerms("a & b | !c <-> (d) e:* 'f'")).toEqual([]);
    expect(searchTerms("payroll:* & !secret | (x)")).toEqual(["payroll", "secret"]);
  });

  it("stops at twelve words, so a pasted page cannot become a huge query", () => {
    const many = Array.from({ length: 40 }, (_, index) => `word${index}`).join(" ");
    expect(searchTerms(many)).toHaveLength(12);
  });

  it("returns nothing for empty text", () => {
    expect(searchTerms("   ")).toEqual([]);
  });
});

describe("metadataSearch", () => {
  it("finds nothing, rather than everything, when the text holds no usable word", () => {
    expect(metadataSearch("?! --", "all")).toBeNull();
    expect(metadataSearch("? ! -", "any")).toBeNull();
  });

  it("all: hands the words to a web-style query, as parameters and never in the SQL text", () => {
    const search = metadataSearch("remote work'; drop table documents", "all");
    const query = render(search!.match);

    expect(query.sql).toContain("websearch_to_tsquery('english', $");
    expect(query.sql).not.toMatch(/drop table/i);
    expect(query.params).toContain("remote work drop table documents");
  });

  it("any: joins the cleaned words with OR, so one shared word is enough", () => {
    const search = metadataSearch("How many days of leave", "any");
    const query = render(search!.match);

    expect(query.sql).toContain("to_tsquery('english', $");
    expect(query.params).toContain("how | many | days | of | leave");
  });

  it("searches the document's name, description, category and tags, and no file", () => {
    const query = render(metadataSearch("leave", "any")!.match);

    expect(query.sql).toMatch(/"documents"\."name"/);
    expect(query.sql).toMatch(/"documents"\."description"/);
    expect(query.sql).toMatch(/"documents"\."category"/);
    expect(query.sql).toMatch(/"documents"\."tags"/);
    expect(query.sql).not.toMatch(/file_url|file_name|"documents"\."metadata"/);
  });
});
