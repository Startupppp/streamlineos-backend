import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";
import { execSync } from "node:child_process";
import { MODULE_REGISTRY } from "../rbac/module-registry";
import { SEAM_BUDGETS } from "../observability/seam-budgets";
import { SLO_CATALOGUE, MODULE_SLOS, QUEUE_SLOS, QUEUE_SUBJECTS, SLO_OWNERS } from "./index";

const BACKEND_ROOT = join(__dirname, "..", "..", "..");
const SRC_ROOT = join(BACKEND_ROOT, "src");

/**
 * Where the runbooks actually live.
 *
 * This was `join(BACKEND_ROOT, "..")`, and the two runbook cases below had been
 * failing with ENOENT — not on a missing heading, which is what they exist to
 * find, but on a directory that has never existed. `architecture-refactor/` is
 * inside the FRONTEND checkout; the parent of the backend holds only the sibling
 * repositories. So these two have never once compared an anchor to a heading.
 *
 * Prefer this worktree's OWN paired frontend — `inv-wt-backend` pairs with
 * `inv-wt-frontend` — over whichever `streamlineos-frontend` happens to sit
 * beside it holding an unrelated branch, or the anchors get checked against
 * another branch's runbooks and drift reads as a pass.
 *
 * It THROWS when nothing resolves. Returning a path that does not exist gives
 * ENOENT, which is at least loud; returning `null` and skipping would make these
 * two cases silently vacuous, which is how five cross-repo drift tests in this
 * codebase resolved to nowhere and reported green for months.
 */
const REPO_ROOT = ((): string => {
  const parent = join(BACKEND_ROOT, "..");
  const own = basename(BACKEND_ROOT).replace(/-backend$/, "-frontend");
  const candidates = [own, "streamlineos-frontend"];
  for (const name of candidates) {
    const candidate = join(parent, name);
    if (existsSync(join(candidate, "architecture-refactor"))) return candidate;
  }
  for (const entry of readdirSync(parent))
    if (existsSync(join(parent, entry, "architecture-refactor"))) return join(parent, entry);
  throw new Error(
    `No checkout beside ${BACKEND_ROOT} holds architecture-refactor/. The runbook ` +
      `assertions cannot resolve their files, and skipping them would make this ` +
      `spec pass over unread documents. Tried: ${candidates.join(", ")}.`,
  );
})();

const EXCLUDED_MODULES = ["crm", "inventory"];

const QUEUE_FILE_SUFFIXES = [
  ".consumer.ts",
  "-worker.service.ts",
  "-outbox-relay.service.ts",
];

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
      continue;
    }
    out.push(full);
  }
  return out;
}

function repoRelative(absolutePath: string): string {
  return relative(BACKEND_ROOT, absolutePath).split(sep).join("/");
}

function discoverQueueFiles(): string[] {
  return walk(SRC_ROOT, [])
    .filter((file) => !file.endsWith(".spec.ts"))
    .filter((file) => QUEUE_FILE_SUFFIXES.some((suffix) => file.endsWith(suffix)))
    .map(repoRelative)
    .filter((file) => !EXCLUDED_MODULES.some((m) => file.includes(`/modules/${m}/`)))
    .sort();
}

function readScript(name: string): string {
  return readFileSync(join(SRC_ROOT, "scripts", name), "utf8");
}

function alertRegistry(): Map<string, { owner: string; anchor: string; file: string | null }> {
  const source = readScript("alert-dispatch.mjs");
  const block = source.slice(source.indexOf("const REGISTRY = {"), source.indexOf("const RUNBOOK_BASE"));
  const entries = new Map<string, { owner: string; anchor: string; file: string | null }>();
  const pattern = /"?([a-z0-9-]+)"?\s*:\s*\{([^}]*)\}/g;
  let match = pattern.exec(block);
  while (match !== null) {
    const id = match[1];
    const body = match[2];
    if (id !== undefined && body !== undefined) {
      const owner = /owner:\s*"([^"]+)"/.exec(body)?.[1];
      const anchor = /runbookAnchor:\s*"([^"]+)"/.exec(body)?.[1];
      const file = /runbookFile:\s*([A-Z_]+)/.exec(body)?.[1] ?? null;
      if (owner !== undefined && anchor !== undefined) entries.set(id, { owner, anchor, file });
    }
    match = pattern.exec(block);
  }
  return entries;
}

function headingSlugs(runbookFile: string): Set<string> {
  const text = readFileSync(join(REPO_ROOT, runbookFile), "utf8");
  const slugs = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading === null) continue;
    const title = heading[1];
    if (title === undefined) continue;
    slugs.add(
      title
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .trim()
        .replace(/\s+/g, "-"),
    );
  }
  return slugs;
}

describe("SLO catalogue", () => {
  it("discovers every queue file on disk, and the discovery is not vacuous", () => {
    const discovered = discoverQueueFiles();
    expect(discovered.length).toBeGreaterThanOrEqual(15);
    expect(discovered).toContain("src/modules/notifications/notification-delivery-worker.service.ts");
    expect(discovered).toContain("src/common/workflow/workflow-outbox-relay.service.ts");
  });

  it("covers every in-scope module with a read and a write objective", () => {
    const inScope = MODULE_REGISTRY.map((m) => m.id).filter(
      (id) => !EXCLUDED_MODULES.includes(id),
    );
    expect(inScope.length).toBeGreaterThanOrEqual(20);

    const missing = inScope.filter(
      (id) =>
        !MODULE_SLOS.some((slo) => slo.subject === id && slo.id.endsWith(":read")) ||
        !MODULE_SLOS.some((slo) => slo.subject === id && slo.id.endsWith(":write")),
    );
    expect(missing).toEqual([]);
  });

  it("declares no objective for an excluded product domain", () => {
    const excluded = MODULE_SLOS.filter((slo) => EXCLUDED_MODULES.includes(slo.subject));
    expect(excluded).toEqual([]);
  });

  it("covers every discovered queue file with an objective", () => {
    const discovered = discoverQueueFiles();
    const covered = new Set(QUEUE_SUBJECTS.map((subject) => subject.sourceFile));
    const uncovered = discovered.filter((file) => !covered.has(file));
    expect(uncovered).toEqual([]);
  });

  it("names no queue subject that has been deleted or moved", () => {
    const stale = QUEUE_SUBJECTS.filter(
      (subject) => !existsSync(join(BACKEND_ROOT, subject.sourceFile)),
    );
    expect(stale.map((s) => s.sourceFile)).toEqual([]);
  });

  it("gives every objective an owner drawn from the single owner vocabulary", () => {
    const declared = new Set<string>(SLO_OWNERS);
    const unknown = SLO_CATALOGUE.filter((slo) => !declared.has(slo.owner));
    expect(unknown.map((s) => `${s.id} -> ${s.owner}`)).toEqual([]);
  });

  it("keeps the alert owner vocabulary and the SLO owner vocabulary from drifting", () => {
    const declared = new Set<string>(SLO_OWNERS);
    const registry = alertRegistry();
    expect(registry.size).toBeGreaterThanOrEqual(10);
    const undeclared = [...registry.entries()].filter(([, entry]) => !declared.has(entry.owner));
    expect(undeclared.map(([id, entry]) => `${id} -> ${entry.owner}`)).toEqual([]);
  });

  it("points every objective at an alert that is registered for dispatch", () => {
    const registry = alertRegistry();
    const unregistered = SLO_CATALOGUE.filter((slo) => !registry.has(slo.alertId));
    expect(unregistered.map((s) => `${s.id} -> ${s.alertId}`)).toEqual([]);
  });

  it("points every objective at a runbook heading that exists", () => {
    const slugCache = new Map<string, Set<string>>();
    const broken: string[] = [];
    for (const slo of SLO_CATALOGUE) {
      const cached = slugCache.get(slo.runbookFile) ?? headingSlugs(slo.runbookFile);
      slugCache.set(slo.runbookFile, cached);
      if (!cached.has(slo.runbookAnchor.replace(/^#/, "")))
        broken.push(`${slo.id} -> ${slo.runbookFile}${slo.runbookAnchor}`);
    }
    expect(broken).toEqual([]);
  });

  it("points every dispatchable alert at a runbook heading that exists", () => {
    const registry = alertRegistry();
    const slugCache = new Map<string, Set<string>>();
    const files: Record<string, string> = {
      FAILURE_RUNBOOK:
        "architecture-refactor/final-refactor/evidence/40-observability/FAILURE-RUNBOOKS.md",
    };
    const base =
      "architecture-refactor/final-refactor/evidence/40-observability/FAILURE-RUNBOOKS.md";
    const broken: string[] = [];
    for (const [id, entry] of registry) {
      const file = entry.file === null ? base : files[entry.file];
      if (file === undefined) {
        broken.push(`${id} -> unresolvable runbookFile ${entry.file}`);
        continue;
      }
      const cached = slugCache.get(file) ?? headingSlugs(file);
      slugCache.set(file, cached);
      if (!cached.has(entry.anchor.replace(/^#/, ""))) broken.push(`${id} -> ${file}${entry.anchor}`);
    }
    expect(broken).toEqual([]);
  });

  it("measures every seam objective against a declared seam budget", () => {
    const declared = new Set(Object.keys(SEAM_BUDGETS));
    const unknown = SLO_CATALOGUE.filter(
      (slo) => slo.indicator.kind === "seam" && !declared.has(slo.indicator.seam),
    );
    expect(unknown.map((s) => s.id)).toEqual([]);
  });

  it("sets every queue target to the number its alert actually fires on", () => {
    const outboxDefault = /--threshold-secs="\)\)\?\.slice\(17\) \?\? "(\d+)"/.exec(
      readScript("alert-queue-age.mjs"),
    )?.[1];
    const retryDefault = /--retry-pressure-threshold="\)\)\?\.slice\(27\) \?\? "(\d+)"/.exec(
      readScript("alert-queue-age.mjs"),
    )?.[1];
    const jobDefault = /--threshold-secs="\)\)\?\.slice\(17\) \?\? "(\d+)"/.exec(
      readScript("alert-job-queue-age.mjs"),
    )?.[1];
    const deadOutboxThreshold = /const THRESHOLD = (\d+);/.exec(
      readScript("alert-dead-outbox.mjs"),
    )?.[1];

    expect(outboxDefault).toBe("300");
    expect(retryDefault).toBe("500");
    expect(jobDefault).toBe("900");
    expect(deadOutboxThreshold).toBe("0");

    for (const slo of QUEUE_SLOS) {
      if (slo.indicator.kind === "queue-age") {
        const expected = slo.alertId === "job-queue-age" ? Number(jobDefault) : Number(outboxDefault);
        expect(slo.indicator.maxPendingAgeSeconds).toBe(expected);
        expect(slo.indicator.maxRetryPressure).toBe(Number(retryDefault));
      }
      if (slo.indicator.kind === "dead-letter")
        expect(slo.indicator.maxDeadRowsInWindow).toBe(Number(deadOutboxThreshold));
    }
  });

  it("registers every job-backed queue in the job-queue alert", () => {
    const script = readScript("alert-job-queue-age.mjs");
    const registered = new Set(
      [...script.matchAll(/\{\s*table:\s*"([a-z_]+)"/g)].map((m) => m[1]),
    );
    expect(registered.size).toBe(8);
    const jobSubjects = QUEUE_SUBJECTS.filter(
      (subject) => subject.channel === "job" && subject.drains.endsWith("_jobs"),
    );
    // Six since the accounting rewrite deleted `finance/**`, and with it the
    // finance report export worker and its `finance_report_export_jobs` queue.
    // The rewrite brought no export queue of its own; lower this again only for
    // a queue that was deliberately removed, never to hide one that went missing.
    expect(jobSubjects.length).toBeGreaterThanOrEqual(6);
    const unwatched = jobSubjects.filter((subject) => !registered.has(subject.drains));
    expect(unwatched.map((s) => s.drains)).toEqual([]);
  });

  it("gives every objective a unique id", () => {
    const ids = SLO_CATALOGUE.map((slo) => slo.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Route attribution", () => {
  const scriptPath = join(SRC_ROOT, "scripts", "route-attribution.mjs");

  // Asserted through behaviour, not source text: the mapping is now derived from the committed module manifest, so a text scan would pin a table that no longer exists.
  const selfTest = (): Record<string, boolean> => {
    const output = execSync(`"${process.execPath}" "${scriptPath}" --self-test`, {
      encoding: "utf8",
    });
    const lastLine = output.trim().split("\n").at(-1) ?? "{}";
    const result = JSON.parse(lastLine) as {
      pass: boolean;
      checks: Record<string, boolean>;
    };
    expect(result.pass).toBe(true);
    expect(Object.keys(result.checks).length).toBeGreaterThan(10);
    return result.checks;
  };

  it("attributes every declared platform namespace to platform-reliability", () => {
    const checks = selfTest();
    expect(checks.healthAttributesToPlatform).toBe(true);
    expect(checks.authAttributesToPlatform).toBe(true);
    expect(checks.cronAttributesToPlatform).toBe(true);
    expect(checks.platformAttributesToPlatform).toBe(true);
  });

  it("resolves the home-administered namespaces to Home, not to themselves", () => {
    const checks = selfTest();
    expect(checks.chatAttributesToCommunicationsViaHome).toBe(true);
    expect(checks.mailAttributesToCommunicationsViaHome).toBe(true);
    expect(checks.calendarAttributesToCommunicationsViaHome).toBe(true);
    expect(checks.notificationsAttributesToHomeNotItsOwnModule).toBe(true);
    expect(checks.partyAttributesToCrmSloExcluded).toBe(true);
  });

  it("handles the route-segment exceptions where module id differs from route first segment", () => {
    const checks = selfTest();
    expect(checks.knowledgeAttributesToKbModule).toBe(true);
    expect(checks.dashboardRouteSegmentAttributesToHome).toBe(true);
  });

  it("self-test passes: hr → people-team, unknown → unattributable, owners differ", () => {
    const checks = selfTest();
    expect(checks.hrAttributesToPeopleTeam).toBe(true);
    expect(checks.unknownNamespaceIsUnattributable).toBe(true);
    expect(checks.ownersDifferBetweenHrAndChat).toBe(true);
    expect(checks.ownersDifferBetweenHrAndHealth).toBe(true);
  });
});
