import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const ROOT = resolve(".");
const CORE = resolve(ROOT, "src/modules/build/core");
const DRY = process.argv.includes("--dry");

const GROUPS = {
  activity: [
    "activity-log-project-id.spec.ts",
    "projects-activity.isolation.spec.ts",
    "projects-activity.savepoint.spec.ts",
    "projects-activity.service.ts",
    "projects-activity-feed.controller.ts",
    "projects-activity-feed.isolation.spec.ts",
    "projects-activity-feed.service.ts",
    "projects-activity-identity.spec.ts",
    "projects-changelog.service.ts",
    "projects-changelog-tenant-isolation.spec.ts",
  ],
  analytics: [
    "projects-analytics.service.ts",
    "projects-analytics-aggregate-coercion.spec.ts",
    "projects-analytics-build-members-budget-tenant-isolation.spec.ts",
    "projects-analytics-filter-propagation.spec.ts",
    "projects-analytics-status-groups.spec.ts",
    "projects-burnup.util.spec.ts",
    "projects-burnup.util.ts",
    "projects-critical-path.util.ts",
    "projects-report-cache-revision.spec.ts",
    "projects-report-limits.ts",
    "projects-reports.controller.ts",
    "projects-reports.service.ts",
    "projects-velocity-report.ts",
  ],
  budget: [
    "projects-budget.controller.ts",
    "projects-budget.service.ts",
    "projects-budget-actual-cost.db.spec.ts",
    "projects-budget-cost-source.spec.ts",
  ],
  "custom-fields": [
    "projects-custom-fields.controller.ts",
    "projects-custom-fields.service.ts",
    "projects-custom-field-values-project-access.spec.ts",
  ],
  "custom-states": [
    "org-custom-states-tenant-isolation.spec.ts",
    "projects-custom-states.service.ts",
    "projects-custom-states-bulk-reorder.spec.ts",
  ],
  customers: [
    "projects-customers.controller.ts",
    "projects-customers.service.ts",
    "projects-customers-keyset.spec.ts",
    "projects-customers-tenant-isolation.spec.ts",
  ],
  "due-sweep": ["build-due-sweep.isolation.spec.ts", "build-due-sweep.service.ts"],
  feedback: ["projects-feedback.service.ts", "projects-feedback-account-link.spec.ts"],
  members: [
    "build-members.controller.ts",
    "build-members.service.ts",
    "build-members-keyset.spec.ts",
    "projects-members.service.ts",
  ],
  notifications: [
    "build-notification-context.service.ts",
    "build-notification-context.spec.ts",
    "build-notification-context-tenant-isolation.spec.ts",
    "build-notification-visibility.ts",
  ],
  releases: [
    "build-release-published-consumer.service.spec.ts",
    "build-release-published-consumer.service.ts",
    "build-release-published-consumer-tenant-isolation.spec.ts",
    "projects-releases.controller.ts",
    "projects-releases.service.ts",
    "projects-releases-by-id-project-access.spec.ts",
    "projects-releases-cross-project-binding.spec.ts",
  ],
  settings: [
    "projects-retention-settings.controller.ts",
    "projects-retention-settings.module.ts",
    "projects-retention-settings.service.ts",
    "projects-settings-iterations.controller.ts",
    "projects-settings-iterations.service.ts",
  ],
  webhooks: [
    "project-webhook-atomicity.spec.ts",
    "projects-webhooks.controller.ts",
    "projects-webhooks.service.ts",
    "projects-webhooks-dispatch.service.ts",
    "projects-webhooks-durability.spec.ts",
    "projects-webhooks-interactive-test.spec.ts",
    "projects-webhooks-signing-secret.spec.ts",
    "projects-webhooks-tenant-isolation.spec.ts",
  ],
  tickets: [
    "assignee-filter.spec.ts",
    "assignee-filter.ts",
    "board-column-aggregate.spec.ts",
    "board-cursor-paging.spec.ts",
    "board-keyset.spec.ts",
    "board-projection.spec.ts",
    "board-query-count.spec.ts",
    "board-rank-index-alignment.spec.ts",
    "build-bulk-mutation-invariants.spec.ts",
    "drag-vs-panel-effects.spec.ts",
    "projects-bulk-write-isolation.spec.ts",
    "projects-comment-identity.spec.ts",
    "projects-labels.service.ts",
    "rank-gap-matches-board-order.spec.ts",
    "workflow-enforcement.spec.ts",
  ],
  "work-query": [
    "all-work-sort-direction.spec.ts",
    "count-by-status-scope.spec.ts",
    "person-ticket-stats-co-assignee.spec.ts",
    "work-scope-mine.spec.ts",
    "work-scope-union.ts",
  ],
  "project-crud": [
    "build-project-aggregate-access.spec.ts",
    "build-project-aggregate-access.ts",
    "build-project-response-contract.spec.ts",
    "project-resources.controller.ts",
    "projects-access.e2e-spec.ts",
    "projects-by-id.controller.ts",
    "projects-by-id.module.ts",
    "projects-scope.e2e-spec.ts",
    "projects-team-access.e2e-spec.ts",
  ],
  lib: ["build-app-paths.spec.ts", "build-app-paths.ts", "projects-recurrence.util.ts"],
};

const STAY = new Set([
  "index.ts",
  "projects.module.ts",
  "projects.controller.ts",
  "projects.controller.e2e-spec.ts",
  "build-actor-migration.spec.ts",
  "build-core-isolation.spec.ts",
  "build-core-services-tenant-isolation.spec.ts",
  "build-cross-tenant-lookup.spec.ts",
  "build-nested-child-cross-project-binding.spec.ts",
  "build-no-pm-workspace-invariant.spec.ts",
  "projects-invoice-line-detail.spec.ts",
  "s04-openapi-pagination.spec.ts",
  "sibling-version-conflict.spec.ts",
]);

const moves = new Map();
for (const [group, files] of Object.entries(GROUPS)) {
  for (const file of files) {
    const from = join(CORE, file);
    if (!existsSync(from)) throw new Error(`missing source file: ${from}`);
    moves.set(from, join(CORE, group, file));
  }
}

const flat = readdirSync(CORE, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name.endsWith(".ts"))
  .map((e) => e.name);
const unassigned = flat.filter((n) => !STAY.has(n) && !moves.has(join(CORE, n)));
if (unassigned.length) throw new Error(`unassigned flat files:\n${unassigned.join("\n")}`);

function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      collect(full, out);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".mts"))) {
      out.push(full);
    }
  }
  return out;
}

const scanRoots = ["src", "test", "evals"].map((d) => resolve(ROOT, d)).filter((d) => existsSync(d));
const allFiles = scanRoots.flatMap((d) => collect(d));

const SPEC_RE =
  /(from\s*|import\s*\(\s*|require\s*\(\s*|jest\.(?:mock|unmock|doMock|setMock|requireActual|requireMock)\s*\(\s*|import\s+)(['"])((?:\.{1,2}\/|src\/)[^'"]*)\2/g;

function toSpec(fromDir, absTarget) {
  let rel = relative(fromDir, absTarget).split(sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return rel;
}

const edits = [];
const unresolved = [];
for (const file of allFiles) {
  const movedFile = moves.has(file);
  const newFile = movedFile ? moves.get(file) : file;
  const oldDir = dirname(file);
  const newDir = dirname(newFile);
  const source = readFileSync(file, "utf8");
  const replacements = [];
  for (const m of source.matchAll(SPEC_RE)) {
    const spec = m[3];
    const specStart = m.index + m[0].length - spec.length - 1;
    let absOld;
    if (spec.startsWith("src/")) absOld = resolve(ROOT, spec);
    else absOld = resolve(oldDir, spec);
    const movedTarget = moves.get(`${absOld}.ts`);
    if (!movedFile && !movedTarget) continue;
    const resolvable =
      existsSync(`${absOld}.ts`) || existsSync(join(absOld, "index.ts")) || existsSync(absOld);
    if (!resolvable) {
      unresolved.push(`${relative(ROOT, file)} -> ${spec}`);
      continue;
    }
    const absNew = movedTarget ? movedTarget.slice(0, -3) : absOld;
    if (spec.startsWith("src/")) {
      if (!movedTarget) continue;
      const next = relative(ROOT, absNew).split(sep).join("/");
      if (next !== spec) replacements.push({ start: specStart, end: specStart + spec.length, next });
      continue;
    }
    const next = toSpec(newDir, absNew);
    if (next !== spec) replacements.push({ start: specStart, end: specStart + spec.length, next });
  }
  if (replacements.length || movedFile) {
    edits.push({ file, newFile, source, replacements });
  }
}

let specCount = 0;
for (const e of edits) specCount += e.replacements.length;
if (unresolved.length) { console.log("UNRESOLVED specifiers (left untouched):"); for (const u of unresolved) console.log("  " + u); }
console.log(`plan: ${moves.size} file move(s), ${edits.filter((e) => e.replacements.length).length} file(s) with rewritten specifiers, ${specCount} specifier rewrite(s)`);

if (DRY) {
  for (const e of edits) {
    if (!e.replacements.length) continue;
    console.log(`  ${relative(ROOT, e.file)}`);
    for (const r of e.replacements) console.log(`      ${e.source.slice(r.start, r.end)}  ->  ${r.next}`);
  }
  process.exit(0);
}

for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

for (const e of edits) {
  let out = e.source;
  for (const r of [...e.replacements].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, r.start) + r.next + out.slice(r.end);
  }
  writeFileSync(e.newFile, out);
}
const FIXUPS = [
  {
    file: join(CORE, "tickets", "drag-vs-panel-effects.spec.ts"),
    from: 'jest.mock("./project-access"',
    to: 'jest.mock("../project-crud/project-access"',
  },
];
for (const fix of FIXUPS) {
  const source = readFileSync(fix.file, "utf8");
  if (!source.includes(fix.from)) throw new Error(`fixup target missing in ${fix.file}: ${fix.from}`);
  writeFileSync(fix.file, source.replace(fix.from, fix.to));
}
console.log(`applied; ${FIXUPS.length} fixup(s)`);
