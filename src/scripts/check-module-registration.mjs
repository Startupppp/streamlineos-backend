#!/usr/bin/env node
/**
 * Registration gate: every module under src/modules is reachable from AppModule.
 *
 * backend/CLAUDE.md §1 — "a new module is not wired until it is registered in
 * app.module.ts; an unregistered module compiles green and does not exist at
 * runtime". `check:module-di` proves a module's own providers resolve, which an
 * orphan module also does, so it cannot see this class of defect.
 *
 * Reachability is computed by walking `imports:` arrays transitively from
 * AppModule, so a module registered only inside another orphan still fails.
 *
 * Flags:
 *   --self-test   Feed known-bad fixtures through the parser and exit.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

function resolvePath(rel) {
  return fileURLToPath(new URL(rel, import.meta.url));
}

const SRC = resolvePath("../");
const BACKEND_ROOT = resolvePath("../../");
const APP_MODULE = join(SRC, "app.module.ts");
const MIN_MODULES = 50;

/** class name → why it is deliberately outside the AppModule graph. */
const STANDALONE = {
  ArchitectureEvidenceModule:
    "minimal context for architecture-evidence CLI commands; booting AppModule made evidence depend on unrelated external integrations",
};

function bracketBodyAt(source, openIndex) {
  let depth = 1;
  let i = openIndex + 1;
  let body = "";
  while (i < source.length && depth > 0) {
    const ch = source[i];
    if (ch === "[") depth++;
    else if (ch === "]") depth--;
    if (depth > 0) body += ch;
    i++;
  }
  return body;
}

/** `const BUILD_MODULES = [ … ]` — the aggregate form `imports:` frequently points at. */
function moduleArrayConstants(source) {
  const constants = new Map();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=]*)?=\s*\[/g))
    constants.set(match[1], bracketBodyAt(source, match.index + match[0].length - 1));
  return constants;
}

/**
 * Captures the class names every `imports:` reaches. Entries may be bare
 * identifiers, `Foo.forRoot()`, `forwardRef(() => Foo)`, a spread, or — the form
 * that made the first version of this gate report 73 false orphans — a reference
 * to a module array declared elsewhere in the file (`imports: BUILD_MODULES`).
 */
export function importedModuleNames(source) {
  const names = new Set();
  const constants = moduleArrayConstants(source);

  const collect = (body, seen) => {
    for (const ident of body.matchAll(/\b([A-Za-z0-9_$]+)\b/g)) {
      const name = ident[1];
      if (/^[A-Z][A-Za-z0-9_]*Module$/.test(name)) names.add(name);
      else if (constants.has(name) && !seen.has(name)) {
        seen.add(name);
        collect(constants.get(name), seen);
      }
    }
  };

  for (const match of source.matchAll(/imports\s*:\s*/g)) {
    const rest = source.slice(match.index + match[0].length);
    if (rest.startsWith("[")) collect(bracketBodyAt(source, match.index + match[0].length), new Set());
    else {
      const ident = /^([A-Za-z0-9_$]+)/.exec(rest);
      if (ident && constants.has(ident[1]))
        collect(constants.get(ident[1]), new Set([ident[1]]));
    }
  }
  return names;
}

export function declaredModuleNames(source) {
  const names = new Set();
  for (const match of source.matchAll(/export\s+class\s+([A-Za-z0-9_]*Module)\b/g))
    names.add(match[1]);
  return names;
}

function collectModuleFiles(dir, files = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) collectModuleFiles(full, files);
    else if (stat.isFile() && entry.endsWith(".module.ts") && !entry.endsWith(".spec.ts"))
      files.push(full);
  }
  return files;
}

function runSelfTests() {
  let passed = 0;
  let failed = 0;
  const assert = (label, condition) => {
    if (condition) passed++;
    else {
      console.error(`  FAIL: ${label}`);
      failed++;
    }
  };

  assert(
    "a bare identifier in imports is found",
    importedModuleNames(`@Module({ imports: [HrModule] })`).has("HrModule"),
  );
  assert(
    "a multi-line imports array is found",
    importedModuleNames(`@Module({\n  imports: [\n    HrModule,\n    BuildModule,\n  ],\n})`).has(
      "BuildModule",
    ),
  );
  assert(
    "a dynamic module call is found — Foo.forRoot() still registers Foo",
    importedModuleNames(`@Module({ imports: [ConfigModule.forRoot({ isGlobal: true })] })`).has(
      "ConfigModule",
    ),
  );
  assert(
    "a forwardRef import is found — the cycle hides the name from a naive scan",
    importedModuleNames(`@Module({ imports: [forwardRef(() => ChatModule)] })`).has("ChatModule"),
  );
  assert(
    "a nested array inside imports does not truncate the scan at the first bracket",
    importedModuleNames(`@Module({ imports: [AModule, ...[BModule, CModule]] })`).has("CModule"),
  );
  assert(
    "imports pointing at a module array constant is found — the form that made this gate report 73 false orphans",
    importedModuleNames(
      `const BUILD_MODULES = [BuildQaModule, BuildTeamsModule];\n@Module({ imports: BUILD_MODULES, exports: BUILD_MODULES })\nexport class BuildModule {}`,
    ).has("BuildQaModule"),
  );
  assert(
    "a spread of a module array constant inside imports is found",
    importedModuleNames(
      `const HR_MODULES = [HrCasesModule];\n@Module({ imports: [...HR_MODULES, HrHubModule] })`,
    ).has("HrCasesModule"),
  );
  assert(
    "a typed module array constant is found",
    importedModuleNames(
      `const KB_MODULES: DynamicModule[] = [KbWikiModule];\n@Module({ imports: KB_MODULES })`,
    ).has("KbWikiModule"),
  );
  assert(
    "a providers array is not mistaken for imports",
    !importedModuleNames(`@Module({ providers: [SomethingModule] })`).has("SomethingModule"),
  );
  assert(
    "an exports-only module array is not mistaken for imports",
    !importedModuleNames(
      `const X_MODULES = [OnlyExportedModule];\n@Module({ providers: [], exports: X_MODULES })`,
    ).has("OnlyExportedModule"),
  );
  assert(
    "a class not ending in Module is ignored",
    !importedModuleNames(`@Module({ imports: [HrService] })`).has("HrService"),
  );
  assert(
    "an exported module class is declared",
    declaredModuleNames(`export class PayrollModule {}`).has("PayrollModule"),
  );
  assert(
    "STANDALONE entries all carry a reason",
    Object.values(STANDALONE).every((v) => typeof v === "string" && v.length > 20),
  );

  if (failed > 0) {
    console.error(`check-module-registration self-tests: ${failed} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-module-registration self-tests: ${passed} passed`);
  process.exit(0);
}

if (process.argv.includes("--self-test")) runSelfTests();

const moduleFiles = collectModuleFiles(SRC);

if (moduleFiles.length < MIN_MODULES) {
  console.error(
    `check-module-registration: vacuity guard — only ${moduleFiles.length} *.module.ts files found (expected >= ${MIN_MODULES}); the scan is broken`,
  );
  process.exit(1);
}

const declaredIn = new Map();
const importsOf = new Map();

for (const file of moduleFiles) {
  const source = readFileSync(file, "utf8");
  const rel = relative(BACKEND_ROOT, file).replace(/\\/g, "/");
  const imported = importedModuleNames(source);
  for (const name of declaredModuleNames(source)) {
    declaredIn.set(name, rel);
    importsOf.set(name, imported);
  }
}

const appSource = readFileSync(APP_MODULE, "utf8");
const reachable = new Set();
const queue = [...importedModuleNames(appSource)];

while (queue.length > 0) {
  const name = queue.pop();
  if (reachable.has(name)) continue;
  reachable.add(name);
  for (const next of importsOf.get(name) ?? []) if (!reachable.has(next)) queue.push(next);
}

const orphans = [];
for (const [name, file] of declaredIn) {
  if (reachable.has(name)) continue;
  if (Object.hasOwn(STANDALONE, name)) continue;
  if (!file.startsWith("src/modules/") && !file.startsWith("src/common/")) continue;
  orphans.push({ name, file });
}

const staleStandalone = Object.keys(STANDALONE).filter(
  (name) => !declaredIn.has(name) || reachable.has(name),
);

console.log(
  `check-module-registration: ${declaredIn.size} module class(es) declared, ${reachable.size} reachable from AppModule, ${orphans.length} unreachable`,
);

if (staleStandalone.length > 0) {
  console.error(`\nSTANDALONE entries that are now reachable or gone — remove them:`);
  for (const name of staleStandalone) console.error(`  ${name}`);
}

if (orphans.length > 0) {
  console.error(`\nDeclared but never reachable from AppModule (backend/CLAUDE.md §1):`);
  for (const o of orphans) console.error(`  ${o.name}\n    ${o.file}`);
  console.error(
    `\nTo fix: register the module in app.module.ts (or in a module that is itself reachable), or delete it.`,
  );
}

process.exit(orphans.length > 0 || staleStandalone.length > 0 ? 1 : 0);
