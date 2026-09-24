import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { ProjectsRoadmapService, ROADMAP_SEARCH_ID_CAP } from "./projects-roadmap.service";
import type { Db } from "../../../db/drizzle.module";
import type { ProjectsChangelogService } from "./projects-changelog.service";
import type { ProjectsFeedbackService } from "./projects-feedback.service";

const dialect = new PgDialect();
const MIGRATION = join(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "migrations",
  "1177_roadmap_search_id_probe.sql",
);

function migrationText(): string {
  return readFileSync(MIGRATION, "utf8");
}

function probeBody(): string {
  const text = migrationText();
  const start = text.indexOf("CREATE OR REPLACE FUNCTION app.search_roadmap_item_ids");
  expect(start).toBeGreaterThanOrEqual(0);
  const open = text.indexOf("AS $$", start);
  const close = text.indexOf("$$;", open);
  expect(close).toBeGreaterThan(open);
  return text.slice(open + "AS $$".length, close);
}

function serviceWithProbe(idRows: Array<{ id: number }>) {
  const execute = jest.fn().mockResolvedValue(idRows);
  const db = { execute } as unknown as Db;
  const svc = new ProjectsRoadmapService(
    db,
    {} as ProjectsChangelogService,
    {} as ProjectsFeedbackService,
  );
  return { svc, execute };
}

function render(value: unknown): string {
  return dialect.sqlToQuery(value as Parameters<PgDialect["sqlToQuery"]>[0]).sql;
}

describe("roadmap search reaches an index instead of scanning the tenant", () => {
  it("routes a searchable term through the probe rather than compiling a leading-wildcard ILIKE", async () => {
    const { svc, execute } = serviceWithProbe([{ id: 4 }, { id: 9 }]);
    const condition = await svc.searchCondition("checkout");
    expect(execute).toHaveBeenCalledTimes(1);
    const sql = render(condition);
    expect(sql).not.toMatch(/ilike/i);
    expect(sql).toContain('"roadmap_items"."id"');
  });

  it("asks the probe for cap + 1 ids, so a truncated list is detectable rather than silently wrong", async () => {
    const { svc, execute } = serviceWithProbe([{ id: 1 }]);
    await svc.searchCondition("checkout");
    const rendered = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(rendered.sql).toContain("app.search_roadmap_item_ids");
    expect(rendered.params).toContain(ROADMAP_SEARCH_ID_CAP + 1);
  });

  it("falls back to plain ILIKE when the probe returns more than the cap, because the id list stops paying for itself", async () => {
    const overflow = Array.from({ length: ROADMAP_SEARCH_ID_CAP + 1 }, (_u, i) => ({ id: i }));
    const { svc } = serviceWithProbe(overflow);
    const sql = render(await svc.searchCondition("checkout"));
    expect(sql).toMatch(/ilike/i);
    expect(sql).toContain('"roadmap_items"."title"');
    expect(sql).toContain('"roadmap_items"."description"');
  });

  it("compiles to a false predicate rather than an empty IN list when nothing matches", async () => {
    const { svc } = serviceWithProbe([]);
    expect(render(await svc.searchCondition("checkout")).trim()).toBe("false");
  });

  it("does not pay for a probe round trip on a term shorter than a trigram", async () => {
    const { svc, execute } = serviceWithProbe([]);
    const sql = render(await svc.searchCondition("ab"));
    expect(execute).not.toHaveBeenCalled();
    expect(sql).toMatch(/ilike/i);
  });

  it("keeps the probe and the fallback over the same two columns, so the cap switch changes the plan and not the answer", async () => {
    const body = probeBody();
    const { svc } = serviceWithProbe([]);
    const fallback = render(svc.searchFallbackCondition("checkout"));
    for (const column of ["title", "description"]) {
      expect(body).toContain(`r.${column} ILIKE`);
      expect(fallback).toContain(`"roadmap_items"."${column}"`);
    }
  });

  it("keeps the probe and the fallback over the same live-row predicate", async () => {
    expect(probeBody()).toContain("r.deleted_at IS NULL");
  });
});

describe("the roadmap search probe is index-aligned and fails closed", () => {
  it("is SECURITY DEFINER, because a search operator is not leakproof and stays a post-filter under RLS", () => {
    expect(migrationText()).toContain("SECURITY DEFINER");
  });

  it("takes its tenant from app.current_org_id() and never from a parameter, so an absent GUC is 42501 and not a cross-tenant read", () => {
    const body = probeBody();
    expect(body).toContain("r.org_id = app.current_org_id()");
    expect(body).not.toMatch(/p_org/);
  });

  it("returns ids only, so the caller's own query still runs under RLS with its tenant clause", () => {
    expect(migrationText()).toContain("RETURNS SETOF integer");
    expect(probeBody()).toMatch(/SELECT\s+r\.id/);
  });

  it("is bounded, because an unbounded set-returning function is materialised in full and loses to the seq scan on a broad term", () => {
    expect(probeBody()).toContain("LIMIT p_limit");
  });

  it("revokes EXECUTE from PUBLIC and grants it only to the application role", () => {
    const text = migrationText();
    expect(text).toContain("REVOKE ALL ON FUNCTION app.search_roadmap_item_ids(text, integer) FROM PUBLIC");
    expect(text).toContain("GRANT EXECUTE ON FUNCTION app.search_roadmap_item_ids(text, integer) TO streamline_app");
  });

  it("creates a trigram index for each column the probe searches, which is what makes the OR a BitmapOr instead of a scan", () => {
    const text = migrationText();
    for (const column of ["title", "description"]) {
      expect(text).toContain(`idx_roadmap_items_${column}_trgm`);
      expect(text).toMatch(
        new RegExp(`USING gin \\(${column} gin_trgm_ops\\)[\\s\\S]{0,60}WHERE deleted_at IS NULL`),
      );
    }
  });

  it("bite proof: a leading-wildcard ILIKE on an unindexed column is the shape this replaced", () => {
    const unindexed = `"roadmap_items"."title" ilike '%checkout%'`;
    expect(unindexed).toMatch(/ilike '%/);
  });
});
