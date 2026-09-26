import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { proposedDocumentScopePredicate } from "./kb-gap-documents";

const dialect = new PgDialect();

function render(fragment: SQL<unknown>): string {
  return dialect.sqlToQuery(fragment).sql;
}

describe("proposedDocumentScopePredicate", () => {
  it("includes the soft-delete guard so a deleted Document is never joined as a proposed article", () => {
    expect(render(proposedDocumentScopePredicate())).toContain('"deleted_at" is null');
  });

  it("does not include a visibility predicate because gap analysis is corpus-wide, not actor-scoped", () => {
    const rendered = render(proposedDocumentScopePredicate());
    expect(rendered).not.toContain("visibility");
    expect(rendered).not.toContain("grant");
  });

  it("includes the support-article Variant guard so wiki pages are never joined as a proposed article", () => {
    expect(render(proposedDocumentScopePredicate())).toContain("content_type");
  });

  it("includes the archive guard so archived Documents do not appear as a proposed article", () => {
    expect(render(proposedDocumentScopePredicate())).toContain('"archived_at" is null');
  });
});

