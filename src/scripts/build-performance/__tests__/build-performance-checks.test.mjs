import { test } from "node:test";
import assert from "node:assert/strict";

import {
  analyse as analyseCacheKeys,
  collectStringConstants,
  extractCacheSites,
  keyShape,
  runSelfTest as runCacheKeySelfTest,
} from "../build-cache-key-readers.mjs";

import {
  analyse as analyseTrigger,
  extractAliasBindings,
  extractFunctionBody,
  extractPendingDrops,
  extractTriggerTargets,
  runSelfTest as runTriggerSelfTest,
  splitTableBranches,
} from "../build-report-revision-integrity.mjs";

test("the cache-key analyser self-test suite passes, so its findings are not vacuous", () => {
  assert.deepEqual(runCacheKeySelfTest(), []);
});

test("the trigger-integrity analyser self-test suite passes, so its findings are not vacuous", () => {
  assert.deepEqual(runTriggerSelfTest(), []);
});

test("two keys differing only in interpolated values normalise to one shape", () => {
  assert.equal(keyShape("projects:analytics:${a}:${b}"), keyShape("projects:analytics:${x}:${y}"));
});

test("adjacent interpolations collapse so a split template does not read as a distinct key", () => {
  assert.equal(keyShape("a:${x}${y}:b"), "a:*:b");
});

test("a key name bound once is resolvable, so a const-indirected read is not reported missing", () => {
  const constants = collectStringConstants("const ns = `build:billing-summary:${orgId}`;");
  assert.equal(constants.get("ns"), "build:billing-summary:${orgId}");
});

test("a key name bound twice resolves to null rather than to whichever literal came first", () => {
  const constants = collectStringConstants("const k = `a:${x}`;\nconst k = `b:${x}`;");
  assert.equal(constants.get("k"), null);
});

test("an unresolvable key argument is emitted as a site with a null shape, never silently skipped", () => {
  const sites = extractCacheSites("this.cache.cached(makeKey(orgId), fn);");
  assert.equal(sites.length, 1);
  assert.equal(sites[0].shape, null);
  assert.equal(sites[0].resolvedFrom, "makeKey");
});

test("an invalidation whose shape has no reader is separated from one that has", () => {
  const result = analyseCacheKeys([
    { path: "read.ts", source: "this.cache.cached(`paired:${orgId}`, fn);" },
    { path: "write.ts", source: "this.cache.del(`paired:${orgId}`);" },
    { path: "orphan.ts", source: "this.cache.del(`orphan:${orgId}`);" },
  ]);
  assert.equal(result.orphanWrites.length, 1);
  assert.equal(result.orphanWrites[0].shape, "orphan:*");
});

test("the trigger function body is extracted between its dollar-quote delimiters", () => {
  const body = extractFunctionBody(
    "CREATE FUNCTION build.bump_report_revision() RETURNS trigger AS $$ BEGIN RETURN NULL; END; $$;",
  );
  assert.match(body, /BEGIN RETURN NULL/);
});

test("a source without the function yields null so the caller cannot pass vacuously", () => {
  assert.equal(extractFunctionBody("CREATE FUNCTION build.other() RETURNS trigger AS $$ $$;"), null);
});

test("every trigger target in the FOREACH array is recovered, including the non-build schema", () => {
  const targets = extractTriggerTargets(
    "FOREACH target IN ARRAY ARRAY['build.tickets', 'build_events.sprint_scope_events'] LOOP",
  );
  assert.deepEqual(targets, ["build.tickets", "build_events.sprint_scope_events"]);
});

test("a JOIN alias binds to its schema-qualified table so column checks resolve", () => {
  const aliases = extractAliasBindings("FROM build.projects p JOIN build.sprints s ON s.id = c.sprint_id");
  assert.equal(aliases.get("p"), "build.projects");
  assert.equal(aliases.get("s"), "build.sprints");
});

test("a TG_TABLE_NAME branch bounds the region a guarded column reference belongs to", () => {
  const branches = splitTableBranches(
    "IF TG_TABLE_NAME = 'sprint_scope_events' THEN x := 1; ELSIF TG_TABLE_NAME = 'work_item_relations' THEN y := 2;",
  );
  assert.equal(branches.length, 2);
  assert.equal(branches[0].table, "sprint_scope_events");
  assert.equal(branches[1].table, "work_item_relations");
});

test("a quoted schema-qualified DROP COLUMN is recognised as pending DDL", () => {
  const { droppedColumns } = extractPendingDrops([
    {
      path: "detach.sql",
      source: 'ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "sprint_id";',
    },
  ]);
  assert.equal(droppedColumns.get("build_events.sprint_scope_events.sprint_id"), "detach.sql");
});

test("an unquoted DROP TABLE is recognised, so quoting style cannot hide a removal", () => {
  const { droppedTables } = extractPendingDrops([
    { path: "drop.sql", source: "DROP TABLE build.sprints;" },
  ]);
  assert.equal(droppedTables.get("build.sprints"), "drop.sql");
});

test("a guarded column reference is charged only to the branch table, not to every trigger target", () => {
  const definitionSql = [
    "CREATE FUNCTION build.bump_report_revision() RETURNS trigger AS $$",
    "BEGIN",
    "IF TG_TABLE_NAME = 'sprint_scope_events' THEN",
    "  affected := 'SELECT c.org_id FROM (x) c JOIN build.sprints s ON s.id = c.sprint_id';",
    "END IF;",
    "END;",
    "$$;",
    "FOREACH target IN ARRAY ARRAY['build.tickets', 'build_events.sprint_scope_events'] LOOP",
  ].join("\n");
  const result = analyseTrigger({
    definitionSql,
    pendingFiles: [
      {
        path: "detach.sql",
        source: [
          'ALTER TABLE "build"."tickets" DROP COLUMN IF EXISTS "sprint_id";',
          'ALTER TABLE "build_events"."sprint_scope_events" DROP COLUMN IF EXISTS "sprint_id";',
        ].join("\n"),
      },
    ],
  });
  const columnFindings = result.findings.filter((f) => f.kind === "column-dropped");
  assert.equal(columnFindings.length, 1);
  assert.equal(columnFindings[0].table, "build_events.sprint_scope_events");
});

test("pending DDL that touches nothing the trigger reads produces no finding", () => {
  const definitionSql = [
    "CREATE FUNCTION build.bump_report_revision() RETURNS trigger AS $$",
    "BEGIN",
    "  affected := 'SELECT org_id, project_id FROM (x) c';",
    "END;",
    "$$;",
    "FOREACH target IN ARRAY ARRAY['build.tickets'] LOOP",
  ].join("\n");
  const result = analyseTrigger({
    definitionSql,
    pendingFiles: [{ path: "other.sql", source: 'ALTER TABLE "hr"."people" DROP COLUMN IF EXISTS "nickname";' }],
  });
  assert.deepEqual(result.findings, []);
});
