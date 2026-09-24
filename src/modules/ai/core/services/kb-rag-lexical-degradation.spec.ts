jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: (db: unknown, fn: (tx: unknown) => Promise<unknown>) => fn(db),
  runInNewTenantTransaction: (db: unknown, _orgId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(db),
}));

import { ServiceUnavailableException } from "@nestjs/common";
import { PgDialect } from "drizzle-orm/pg-core";
import { type SQL } from "drizzle-orm";
import { InsufficientAiCreditsException } from "../../../../common/http/api-exceptions";
import { KbRagRetrievalService } from "./kb-rag-retrieval.service";

const ORG = "org-public";
const QUESTION = "how do I reset my password";

const dialect = new PgDialect();

function render(cond: SQL): { text: string; params: unknown[] } {
  const query = dialect.sqlToQuery(cond);
  return { text: query.sql, params: query.params };
}

const chunkRow = {
  id: 1,
  articleId: 10,
  attachmentId: null,
  source: "article_body",
  content: "Open the account page and choose reset.",
  title: "Password reset",
  slug: "password-reset",
  attachmentName: null,
  similarity: 0.85,
};

type EmbedBehaviour =
  | { mode: "ok" }
  | { mode: "failure"; kind: string }
  | { mode: "throws" };

function makeHarness(embed: EmbedBehaviour, rows: unknown[] = [chunkRow]) {
  const wheres: SQL[] = [];
  const orders: SQL[] = [];
  const joins: SQL[] = [];
  const projections: Record<string, unknown>[] = [];
  const chain: Record<string, jest.Mock> = {
    from: jest.fn(() => chain),
    innerJoin: jest.fn((_table: unknown, on: SQL) => {
      joins.push(on);
      return chain;
    }),
    leftJoin: jest.fn((_table: unknown, on: SQL) => {
      joins.push(on);
      return chain;
    }),
    where: jest.fn((cond: SQL) => {
      wheres.push(cond);
      return chain;
    }),
    orderBy: jest.fn((order: SQL) => {
      orders.push(order);
      return chain;
    }),
    limit: jest.fn(() => Promise.resolve(rows)),
  };
  const db = {
    select: jest.fn((projection: Record<string, unknown>) => {
      projections.push(projection);
      return chain;
    }),
  };
  const embedQueryWithCredit = jest.fn();
  if (embed.mode === "ok")
    embedQueryWithCredit.mockResolvedValue({
      ok: true,
      vector: [0.1, 0.2],
      vectorLiteral: "[0.1,0.2]",
    });
  else if (embed.mode === "failure")
    embedQueryWithCredit.mockResolvedValue({
      ok: false,
      kind: embed.kind,
      message: "unavailable",
      correlationId: "corr-1",
    });
  else embedQueryWithCredit.mockRejectedValue(new Error("socket hang up"));

  const aiGateway = {
    isEmbeddingConfigured: jest.fn().mockReturnValue(true),
    embedQueryWithCredit,
  };
  const service = new KbRagRetrievalService(db as never, aiGateway as never);
  return { service, wheres, orders, joins, projections };
}

describe("public KB retrieveContext degrades to lexical rather than taking the feature down with a 503", () => {
  it("still ranks by vector distance when the embedding provider answers, so the happy path is unregressed", async () => {
    const { service, orders } = makeHarness({ mode: "ok" });

    const context = await service.retrieveContext(ORG, QUESTION);

    expect(context?.sources).toHaveLength(1);
    expect(context?.degraded).toBeUndefined();
    expect(render(orders[0] as SQL).text).toContain("<=>");
  });

  it("returns a lexical context instead of throwing when embedQueryWithCredit reports the provider is unavailable", async () => {
    const { service, orders } = makeHarness({ mode: "failure", kind: "provider_unavailable" });

    const context = await service.retrieveContext(ORG, QUESTION);

    expect(context?.sources.length).toBeGreaterThan(0);
    expect(context?.degraded).toBe(true);
    expect(render(orders[0] as SQL).text).toContain("ts_rank");
  });

  it("returns a lexical context instead of throwing when embedQueryWithCredit is not configured", async () => {
    const { service } = makeHarness({ mode: "failure", kind: "not_configured" });

    const context = await service.retrieveContext(ORG, QUESTION);

    expect(context?.sources.length).toBeGreaterThan(0);
    expect(context?.degraded).toBe(true);
  });

  it("returns a lexical context instead of throwing when embedQueryWithCredit throws", async () => {
    const { service } = makeHarness({ mode: "throws" });

    const context = await service.retrieveContext(ORG, QUESTION);

    expect(context?.sources.length).toBeGreaterThan(0);
    expect(context?.degraded).toBe(true);
  });

  it("keeps the org, published, public and space-audience predicates on the lexical fallback query", async () => {
    const { service, wheres } = makeHarness({ mode: "failure", kind: "provider_unavailable" });

    await service.retrieveContext(ORG, QUESTION);

    const { text, params } = render(wheres[0] as SQL);
    const org = /"kb_article_chunks"\."org_id"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(org?.[1]) - 1]).toBe(ORG);
    const status = /"kb_pages"\."status"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(status?.[1]) - 1]).toBe("published");
    const visibility = /"kb_pages"\."visibility"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(visibility?.[1]) - 1]).toBe("public");
    expect(text).toContain('"kb_spaces"."audience" in');
    expect(text).toContain('"kb_spaces"."deleted_at" is null');
  });

  it("restricts the corpus to live support articles, so a wiki page is never quoted to an anonymous asker", async () => {
    const { service, wheres } = makeHarness({ mode: "failure", kind: "provider_unavailable" });

    await service.retrieveContext(ORG, QUESTION);

    const { text, params } = render(wheres[0] as SQL);
    const contentType = /"kb_pages"\."content_type"\s*=\s*\$(\d+)/.exec(text);
    expect(params[Number(contentType?.[1]) - 1]).toBe("support_article");
    expect(text).toContain('"kb_pages"."deleted_at" is null');
  });

  it("anchors chunks on page_id, because article_id no longer resolves to a table", async () => {
    const { service, joins } = makeHarness({ mode: "failure", kind: "provider_unavailable" });

    await service.retrieveContext(ORG, QUESTION);

    const { text } = render(joins[0] as SQL);
    expect(text).toContain('"kb_article_chunks"."page_id"');
    expect(text).not.toContain('"kb_article_chunks"."article_id"');
  });

  it("narrows the lexical fallback to articles whose own text matches, never the whole public corpus", async () => {
    const { service, wheres } = makeHarness({ mode: "failure", kind: "provider_unavailable" });

    await service.retrieveContext(ORG, QUESTION);

    const { text, params } = render(wheres[0] as SQL);
    expect(text).toContain('"kb_pages"."fts" @@ websearch_to_tsquery');
    expect(params).toContain(QUESTION);
  });

  it("keeps the vector similarity floor off the lexical branch, whose ts_rank scores are not similarities", async () => {
    const lowRankRow = { ...chunkRow, similarity: 0.02 };
    const degraded = makeHarness({ mode: "failure", kind: "provider_unavailable" }, [lowRankRow]);
    const healthy = makeHarness({ mode: "ok" }, [lowRankRow]);

    const degradedContext = await degraded.service.retrieveContext(ORG, QUESTION);
    const healthyContext = await healthy.service.retrieveContext(ORG, QUESTION);

    expect(degradedContext?.sources.length).toBeGreaterThan(0);
    expect(healthyContext?.sources).toHaveLength(0);
  });

  it("still charges the caller and refuses when the org is out of AI credits, so degradation cannot bypass quota", async () => {
    const { service } = makeHarness({ mode: "failure", kind: "quota_exceeded" });

    await expect(service.retrieveContext(ORG, QUESTION)).rejects.toThrow(
      InsufficientAiCreditsException,
    );
  });

  it("still backs off when the org exceeds its concurrency allowance, so degradation cannot defeat the limiter", async () => {
    const { service } = makeHarness({ mode: "failure", kind: "concurrency_exceeded" });

    await expect(service.retrieveContext(ORG, QUESTION)).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
