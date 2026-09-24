import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const READ_CALLS = ["cached", "cachedVersioned", "cachedVersionedForOrg"];
const WRITE_CALLS = ["del", "invalidateNamespace", "invalidateNamespaceForOrg"];

export function keyShape(literal) {
  return literal
    .replace(/\$\{[^}]*\}/g, "*")
    .replace(/\*+/g, "*")
    .trim();
}

export function collectStringConstants(source) {
  const constants = new Map();
  const pattern = /\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(`[^`]*`|"[^"]*"|'[^']*')\s*;/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const name = match[1];
    if (constants.has(name)) {
      constants.set(name, null);
      continue;
    }
    constants.set(name, match[2].slice(1, -1));
  }
  return constants;
}

export function extractCacheSites(source) {
  const constants = collectStringConstants(source);
  const sites = [];
  const pattern =
    /(?:cache|this\.cache)\s*\n?\s*\.\s*(cachedVersionedForOrg|cachedVersioned|cached|invalidateNamespaceForOrg|invalidateNamespace|del)\s*\(\s*(`[^`]*`|"[^"]*"|'[^']*'|[A-Za-z_$][\w$]*)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const call = match[1];
    const argument = match[2];
    const quoted = /^[`"']/.test(argument);
    const raw = quoted ? argument.slice(1, -1) : constants.get(argument);
    const line = source.slice(0, match.index).split("\n").length;
    if (raw === undefined || raw === null) {
      sites.push({
        call,
        kind: READ_CALLS.includes(call) ? "read" : "write",
        literal: null,
        resolvedFrom: argument,
        shape: null,
        line,
      });
      continue;
    }
    sites.push({
      call,
      kind: READ_CALLS.includes(call) ? "read" : "write",
      literal: raw,
      resolvedFrom: quoted ? null : argument,
      shape: keyShape(raw),
      line,
    });
  }
  return sites;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    if (entry.includes(".spec.") || entry.includes(".e2e-spec.")) continue;
    out.push(full);
  }
  return out;
}

export function analyse(files) {
  const reads = new Map();
  const writes = new Map();
  const unresolved = [];
  for (const { path, source } of files) {
    for (const site of extractCacheSites(source)) {
      if (site.shape === null) {
        unresolved.push({ ...site, path });
        continue;
      }
      const bucket = site.kind === "read" ? reads : writes;
      const list = bucket.get(site.shape) ?? [];
      list.push({ ...site, path });
      bucket.set(site.shape, list);
    }
  }

  const orphanWrites = [];
  for (const [shape, sites] of writes) {
    if (reads.has(shape)) continue;
    orphanWrites.push({ shape, sites });
  }

  const orphanReads = [];
  for (const [shape, sites] of reads) {
    if (writes.has(shape)) continue;
    orphanReads.push({ shape, sites });
  }

  return { reads, writes, orphanWrites, orphanReads, unresolved };
}

function loadBuildModule(root) {
  const moduleRoot = join(root, "src", "modules", "build");
  return walk(moduleRoot).map((path) => ({
    path: relative(root, path).split(sep).join("/"),
    source: readFileSync(path, "utf8"),
  }));
}

const SELF_TEST_CASES = [
  {
    name: "an invalidated shape with no read site is reported",
    files: [
      { path: "a.ts", source: "await this.cache.del(`projects:analytics:${orgId}:${projectId}`);" },
    ],
    expect: (result) => result.orphanWrites.length === 1 && result.orphanReads.length === 0,
  },
  {
    name: "a read and an invalidation of the same shape cancel out",
    files: [
      { path: "a.ts", source: "return this.cache.cached(`x:${orgId}:${id}`, fn, 30);" },
      { path: "b.ts", source: "await this.cache.del(`x:${orgId}:${id}`);" },
    ],
    expect: (result) => result.orphanWrites.length === 0 && result.orphanReads.length === 0,
  },
  {
    name: "a cached read with no invalidator is reported as a TTL-only cache",
    files: [{ path: "a.ts", source: "return this.cache.cached(`y:${orgId}`, fn, 300);" }],
    expect: (result) => result.orphanReads.length === 1,
  },
  {
    name: "differing interpolations collapse to the same shape",
    files: [
      { path: "a.ts", source: "this.cache.cached(`z:${a}:${b}`, fn);" },
      { path: "b.ts", source: "this.cache.del(`z:${orgId}:${projectId}`);" },
    ],
    expect: (result) => result.orphanWrites.length === 0,
  },
  {
    name: "a call split across lines is still matched",
    files: [
      { path: "a.ts", source: "await this.cache\n  .del(`split:${orgId}`);" },
    ],
    expect: (result) => result.orphanWrites.length === 1,
  },
  {
    name: "a bare cache identifier is matched as well as this.cache",
    files: [{ path: "a.ts", source: "await cache.del(`bare:${orgId}`);" }],
    expect: (result) => result.orphanWrites.length === 1,
  },
  {
    name: "a key bound to a const and passed by name resolves to the same shape as its invalidator",
    files: [
      {
        path: "a.ts",
        source:
          "const ns = `build:billing-summary:${orgId}`;\nreturn this.cache.cachedVersioned(ns, subKey, fn);\nawait this.cache.invalidateNamespace(`build:billing-summary:${user.orgId}`);",
      },
    ],
    expect: (result) => result.orphanWrites.length === 0 && result.orphanReads.length === 0,
  },
  {
    name: "a name rebound to two different literals is reported unresolved rather than resolved to the wrong one",
    files: [
      {
        path: "a.ts",
        source: "const k = `one:${a}`;\nconst k = `two:${a}`;\nthis.cache.del(k);",
      },
    ],
    expect: (result) =>
      result.orphanWrites.length === 0 && result.writes.size === 0 && result.unresolved.length === 1,
  },
  {
    name: "a key built by a helper call is reported unresolved, never counted as absent",
    files: [{ path: "a.ts", source: "this.cache.cached(buildKey(orgId), fn);" }],
    expect: (result) => result.unresolved.length === 1 && result.reads.size === 0,
  },
];

export function runSelfTest() {
  const failures = [];
  for (const testCase of SELF_TEST_CASES) {
    const result = analyse(testCase.files);
    if (!testCase.expect(result)) failures.push(testCase.name);
  }
  return failures;
}

function main(argv) {
  if (argv.includes("--self-test")) {
    const failures = runSelfTest();
    if (failures.length) {
      for (const name of failures) console.error(`  FAIL  ${name}`);
      console.error(`self-test FAILED — ${String(failures.length)} case(s)`);
      return 1;
    }
    console.log(`self-test passed — ${String(SELF_TEST_CASES.length)} case(s)`);
    return 0;
  }

  const root = process.cwd();
  const files = loadBuildModule(root);
  const { reads, writes, orphanWrites, orphanReads, unresolved } = analyse(files);

  console.log(`=== build cache key readers — ${String(files.length)} file(s) scanned ===`);
  console.log(
    `read shapes: ${String(reads.size)} · invalidated shapes: ${String(writes.size)} · unresolved call sites: ${String(unresolved.length)}`,
  );

  if (unresolved.length) {
    console.log("");
    console.log("UNRESOLVED KEY ARGUMENTS (not evidence of absence — this tool cannot see these):");
    for (const site of unresolved)
      console.log(`  ${site.path}:${String(site.line)}  .${site.call}(${site.resolvedFrom})`);
  }

  if (orphanWrites.length) {
    console.log("");
    console.log("INVALIDATED WITH NO READER (the eviction reaches nothing):");
    for (const { shape, sites } of orphanWrites) {
      console.log(`  ${shape} — ${String(sites.length)} write site(s)`);
      for (const site of sites) console.log(`      ${site.path}:${String(site.line)}  .${site.call}()`);
    }
  }

  if (orphanReads.length) {
    console.log("");
    console.log("CACHED WITH NO INVALIDATOR (TTL-only staleness):");
    for (const { shape, sites } of orphanReads) {
      console.log(`  ${shape} — ${String(sites.length)} read site(s)`);
      for (const site of sites) console.log(`      ${site.path}:${String(site.line)}  .${site.call}()`);
    }
  }

  if (!orphanWrites.length && !orphanReads.length) {
    console.log("");
    console.log("PASS — every invalidated key shape has a reader and every read shape has an invalidator.");
    return 0;
  }
  console.log("");
  console.log(
    `REPORT — ${String(orphanWrites.length)} orphaned invalidation shape(s), ${String(orphanReads.length)} reader-only shape(s).`,
  );
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
