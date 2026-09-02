#!/usr/bin/env node
/**
 * Verifies that every outbox event type emitted via OutboxWriter.emit() is handled by a consumer
 * that is actually REGISTERED at runtime.
 *
 * WHY THIS CHECKS REGISTRATION AND NOT A STRING
 * ---------------------------------------------
 * The previous version of this gate answered "is this event type consumed?" by string-matching a
 * `readonly eventType = "..."` literal anywhere in the source tree. That is a property of a FILE,
 * not of a running system. `BuildTicketStatusChangedConsumerService` declared
 * `readonly eventType = "build.ticket.status_changed"`, was imported by nothing but its own spec,
 * and was absent from `projects.module.ts` — so its `onModuleInit` never ran, it never called
 * `registry.register(this)`, and `OutboxPublisherService.deliver` threw
 * "no dispatch handler for event type" on every ticket status change until the event dead-lettered.
 * The gate reported that event as consumed, because the literal it matched was inside the orphan
 * file itself. A gate that certifies delivery it cannot observe is worse than no gate.
 *
 * A consumer counts as registered only when all of these hold:
 *   1. it declares an event type (`readonly eventType = <literal|CONST>`, or an inline
 *      `registry.register({ eventType: ... })`);
 *   2. its class is listed in the `providers` of some `@Module`;
 *   3. that module is reachable from `AppModule` by following `imports` — CLAUDE.md §1: "a new
 *      module is not wired until it is registered in app.module.ts".
 * Module imports are resolved through each file's own `import` statements, so two modules sharing a
 * class name (`OrganizationModule` exists twice) cannot be confused for one another.
 *
 * Usage:
 *   node src/scripts/check-outbox-consumers.mjs          # production check
 *   node src/scripts/check-outbox-consumers.mjs --self-test
 *
 * Exit codes: 0 ok · 1 orphaned or unregistered consumer · 2 scan too small to conclude anything.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_TEST = process.argv.includes("--self-test");

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const SRC_ROOT = resolve(__dirname, "..");
const ROOT_MODULE_FILE = join(SRC_ROOT, "app.module.ts");
const ROOT_MODULE_CLASS = "AppModule";

const MIN_FILES = 500;
const MIN_EMITTED = 5;
const MIN_CONSUMED = 5;
const MIN_REGISTERED_PROVIDERS = 200;

const CONST_RE = /\bconst\s+([A-Z][A-Z0-9_]+)\s*=\s*(["'][^"']+["'])/gm;
const EMIT_RE = /OutboxWriter\.emit\s*\(/g;
const CONSUMER_RE = /\breadonly\s+eventType\s*=\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/g;
const INLINE_RE = /\bregistry\s*\.\s*register\s*\(/g;
const EVENT_TYPE_PROP = /\beventType\s*:\s*(["'][^"']+["']|[A-Z][A-Z0-9_]+)/;
const CLASS_DECL_RE = /\bclass\s+([A-Za-z_$][\w$]*)/g;
const IMPORT_RE = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
const MODULE_DECORATOR_RE = /@Module\s*\(/g;
const IDENTIFIER_RE = /[A-Za-z_$][\w$]*/g;

/**
 * Test files are not runtime sources, and scanning them makes this gate answer the wrong question
 * twice over: a consumer class that exists only in a spec would "clear" an emitted type it can
 * never handle in production, and a spec that merely mentions the shape — a regex over
 * `readonly eventType = "..."`, say — reads as a consumer declaration. Only real sources count.
 */
export function isRuntimeSource(path) {
  if (!path.endsWith(".ts")) return false;
  if (path.endsWith(".d.ts")) return false;
  if (/\.(?:spec|e2e-spec|test)\.ts$/.test(path)) return false;
  return !/(?:^|[/\\])(?:__tests__|__mocks__|test)[/\\]/.test(path);
}

/** Recursively collect runtime .ts files under a directory (skip node_modules, dist, tests). */
function collectTsFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) results.push(...collectTsFiles(full));
    else if (isRuntimeSource(full)) results.push(full);
  }
  return results;
}

function resolveValue(raw, constMap) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) return trimmed.slice(1, -1);
  return constMap.get(trimmed) ?? null;
}

/** Slice the balanced (…) or […] or {…} region starting at `openIndex`. */
function balancedSlice(src, openIndex, open, close) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const ch = src[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return src.slice(openIndex, i + 1);
    }
  }
  return null;
}

/** Module-level `const NAME = [ … ]` array literals in a file, as raw text. */
function arrayConstants(src) {
  const consts = new Map();
  for (const m of src.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\[/g)) {
    const slice = balancedSlice(src, src.indexOf("[", m.index + m[0].length - 1), "[", "]");
    if (slice) consts.set(m[1], slice);
  }
  return consts;
}

/**
 * The `key:` section of a @Module object, as raw text.
 *
 * It is NOT always an inline array literal. `build.module.ts` and `kb.module.ts` hoist their child
 * modules into `const BUILD_MODULES = [...]` / `const KB_MODULES = [...]` and write
 * `imports: BUILD_MODULES`. An earlier version of this parser only understood `key: [`, so those
 * two subtrees — Build and KB among others — resolved as unreachable from AppModule and the gate
 * reported six false orphans. Resolve the indirection instead of assuming the literal form.
 */
function moduleArraySection(decoratorBody, key, arrayConsts) {
  const inline = decoratorBody.search(new RegExp(`\\b${key}\\s*:\\s*\\[`));
  if (inline !== -1)
    return balancedSlice(decoratorBody, decoratorBody.indexOf("[", inline), "[", "]");
  const viaConst = new RegExp(`\\b${key}\\s*:\\s*([A-Za-z_$][\\w$]*)`).exec(decoratorBody);
  if (viaConst) return arrayConsts.get(viaConst[1]) ?? null;
  return null;
}

/**
 * Class names referenced by a @Module `imports`/`providers` array. Deliberately generous: it takes
 * every capitalised identifier in the section, so `ConfigModule.forRoot({...})`,
 * `forwardRef(() => XModule)` and `{ provide: APP_GUARD, useClass: JwtAuthGuard }` all yield their
 * class. Over-collecting can only ever make a consumer look MORE registered than it is at the level
 * of a single module, and step 3 (reachability from AppModule) is what keeps the gate honest.
 */
function referencedClasses(section, arrayConsts = new Map(), seen = new Set()) {
  if (!section) return [];
  const names = new Set();
  for (const m of section.matchAll(IDENTIFIER_RE)) {
    const name = m[0];
    if (!/^[A-Z]/.test(name)) continue;
    // A spread or nested reference to another array const (`...BUILD_MODULES`) expands rather
    // than being mistaken for a module class of that name.
    if (arrayConsts.has(name) && !seen.has(name)) {
      seen.add(name);
      for (const nested of referencedClasses(arrayConsts.get(name), arrayConsts, seen))
        names.add(nested);
      continue;
    }
    names.add(name);
  }
  return [...names];
}

/** Symbol → absolute file path, from a file's own import statements. */
function importedSymbolPaths(filePath, src, fileSet) {
  const map = new Map();
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[2];
    if (!spec.startsWith(".")) continue;
    const base = resolve(dirname(filePath), spec);
    const candidates = [`${base}.ts`, join(base, "index.ts")];
    const target = candidates.find((c) => fileSet.has(c) || existsSync(c));
    if (!target) continue;
    for (const raw of m[1].split(",")) {
      const name = raw.replace(/\btype\b/, "").split(/\bas\b/)[0].trim();
      if (name) map.set(name, target);
    }
  }
  return map;
}

/** Every @Module in a file, keyed by the class the decorator is attached to. */
function parseModules(filePath, src) {
  const modules = [];
  const arrayConsts = arrayConstants(src);
  MODULE_DECORATOR_RE.lastIndex = 0;
  for (const m of src.matchAll(MODULE_DECORATOR_RE)) {
    const call = balancedSlice(src, src.indexOf("(", m.index), "(", ")");
    if (!call) continue;
    const after = src.slice(m.index + call.length);
    CLASS_DECL_RE.lastIndex = 0;
    const decl = CLASS_DECL_RE.exec(after);
    if (!decl) continue;
    modules.push({
      file: filePath,
      className: decl[1],
      imports: referencedClasses(moduleArraySection(call, "imports", arrayConsts), arrayConsts),
      providers: referencedClasses(moduleArraySection(call, "providers", arrayConsts), arrayConsts),
    });
  }
  return modules;
}

/** The class a source position sits inside — the last `class X` declared at or before it. */
function enclosingClass(src, index) {
  CLASS_DECL_RE.lastIndex = 0;
  let name = null;
  for (const m of src.matchAll(CLASS_DECL_RE)) {
    if (m.index > index) break;
    name = m[1];
  }
  return name;
}

/**
 * The whole detector, over a path → source map. The gate and the self-test both call this, so the
 * self-test exercises the real scanners rather than a re-declared copy of the rules.
 */
export function analyseSources(sourceByFile, options = {}) {
  const rootFile = options.rootModuleFile ?? ROOT_MODULE_FILE;
  const rootClass = options.rootModuleClass ?? ROOT_MODULE_CLASS;
  const fileSet = new Set(sourceByFile.keys());

  const constMap = new Map();
  for (const src of sourceByFile.values()) {
    for (const m of src.matchAll(CONST_RE)) {
      const name = m[1];
      if (!constMap.has(name)) constMap.set(name, m[2].slice(1, -1));
    }
  }

  const emittedByFile = new Map();
  const declaredConsumers = [];
  const modulesByFile = new Map();
  const importPathsByFile = new Map();

  const add = (map, filePath, value) => {
    const entry = map.get(filePath) ?? new Set();
    entry.add(value);
    map.set(filePath, entry);
  };

  for (const [filePath, src] of sourceByFile) {
    EMIT_RE.lastIndex = 0;
    let match;
    while ((match = EMIT_RE.exec(src)) !== null) {
      const typeMatch = EVENT_TYPE_PROP.exec(src.slice(match.index, match.index + 600));
      if (!typeMatch) continue;
      const resolved = resolveValue(typeMatch[1], constMap);
      if (resolved) add(emittedByFile, filePath, resolved);
    }

    CONSUMER_RE.lastIndex = 0;
    while ((match = CONSUMER_RE.exec(src)) !== null) {
      const resolved = resolveValue(match[1], constMap);
      if (!resolved) continue;
      declaredConsumers.push({
        file: filePath,
        className: enclosingClass(src, match.index),
        eventType: resolved,
        kind: "class",
      });
    }

    INLINE_RE.lastIndex = 0;
    while ((match = INLINE_RE.exec(src)) !== null) {
      const typeMatch = EVENT_TYPE_PROP.exec(src.slice(match.index, match.index + 400));
      if (!typeMatch) continue;
      const resolved = resolveValue(typeMatch[1], constMap);
      if (!resolved) continue;
      declaredConsumers.push({
        file: filePath,
        className: enclosingClass(src, match.index),
        eventType: resolved,
        kind: "inline",
      });
    }

    if (filePath.endsWith(".module.ts") || src.includes("@Module(")) {
      const parsed = parseModules(filePath, src);
      if (parsed.length > 0) {
        modulesByFile.set(filePath, parsed);
        importPathsByFile.set(filePath, importedSymbolPaths(filePath, src, fileSet));
      }
    }
  }

  // Walk the module graph from AppModule, resolving each `imports` entry through the importing
  // file's own import statements so same-named modules in different folders stay distinct.
  const registeredProviders = new Set();
  const reachableModules = new Set();
  const rootModules = modulesByFile.get(rootFile) ?? [];
  const queue = rootModules
    .filter((m) => m.className === rootClass)
    .map((m) => ({ file: rootFile, mod: m }));

  while (queue.length > 0) {
    const { file, mod } = queue.pop();
    const key = `${file}#${mod.className}`;
    if (reachableModules.has(key)) continue;
    reachableModules.add(key);
    for (const provider of mod.providers) registeredProviders.add(provider);

    const importPaths = importPathsByFile.get(file) ?? new Map();
    for (const imported of mod.imports) {
      const targetFile = importPaths.get(imported);
      const candidates = targetFile
        ? (modulesByFile.get(targetFile) ?? []).map((m) => ({ file: targetFile, mod: m }))
        : [...modulesByFile.entries()].flatMap(([f, ms]) =>
            ms.filter((m) => m.className === imported).map((m) => ({ file: f, mod: m })),
          );
      for (const candidate of candidates)
        if (candidate.mod.className === imported) queue.push(candidate);
    }
  }

  const isRegistered = (consumer) =>
    consumer.className !== null && registeredProviders.has(consumer.className);

  const registeredConsumers = declaredConsumers.filter(isRegistered);
  const unregisteredConsumers = declaredConsumers.filter((c) => !isRegistered(c));

  const allEmitted = new Set([...emittedByFile.values()].flatMap((s) => [...s]));
  const allConsumed = new Set(registeredConsumers.map((c) => c.eventType));
  const allDeclared = new Set(declaredConsumers.map((c) => c.eventType));
  // An event type is only orphaned if NO registered consumer handles it; a second, unregistered
  // declaration of an already-registered type is a duplicate, not an orphan.
  const orphans = [...allEmitted].filter((t) => !allConsumed.has(t));
  const unregisteredOnly = unregisteredConsumers.filter((c) => !allConsumed.has(c.eventType));

  return {
    allEmitted,
    allConsumed,
    allDeclared,
    orphans,
    emittedByFile,
    declaredConsumers,
    registeredConsumers,
    unregisteredConsumers,
    unregisteredOnly,
    registeredProviders,
    reachableModules,
    constMap,
  };
}

function isVacuous(fileCount, emittedCount, consumedCount, providerCount) {
  return (
    fileCount < MIN_FILES ||
    emittedCount < MIN_EMITTED ||
    consumedCount < MIN_CONSUMED ||
    providerCount < MIN_REGISTERED_PROVIDERS
  );
}

function runSelfTest() {
  let passed = 0;
  const failures = [];
  const assert = (label, condition) => {
    if (condition) passed++;
    else failures.push(label);
  };

  const emitter = `
    const REMINDER_DUE = "accounting.invoice.reminder.due";
    export class Svc {
      async run(tx) {
        await OutboxWriter.emit(tx, { eventType: "test.event.orphaned", payload: {} });
        await OutboxWriter.emit(tx, { eventType: REMINDER_DUE, payload: {} });
        await OutboxWriter.emit(tx, { eventType: "test.event.inline-consumed", payload: {} });
        await OutboxWriter.emit(tx, { eventType: "test.event.declared-but-unwired", payload: {} });
        await OutboxWriter.emit(tx, { eventType: COMPUTED_AT_RUNTIME, payload: {} });
      }
    }
  `;
  const consumer = `
    export class ReminderConsumer {
      readonly eventType = "accounting.invoice.reminder.due";
      handle() {}
    }
  `;
  const inlineConsumer = `
    export class InlineConsumer {
      onModuleInit() {
        this.registry.register(this);
        this.registry.register({ eventType: "test.event.inline-consumed", handle: (e) => this.handle(e) });
      }
    }
  `;
  // The regression this gate exists for: a real consumer class, in a real file, that no module
  // lists as a provider. Its `onModuleInit` never runs, so it registers nothing at runtime.
  const orphanConsumer = `
    export class UnwiredConsumer {
      readonly eventType = "test.event.declared-but-unwired";
      handle() {}
    }
  `;
  const featureModule = `
    import { ReminderConsumer } from "./consumer";
    import { InlineConsumer } from "./inline";
    @Module({ providers: [ReminderConsumer, InlineConsumer] })
    export class FeatureModule {}
  `;
  const appModule = `
    import { FeatureModule } from "./b/feature.module";
    @Module({ imports: [FeatureModule], providers: [] })
    export class AppModule {}
  `;

  const base = "/repo/src";
  const sources = new Map([
    [`${base}/a/emitter.service.ts`, emitter],
    [`${base}/b/consumer.ts`, consumer],
    [`${base}/b/inline.ts`, inlineConsumer],
    [`${base}/b/unwired.ts`, orphanConsumer],
    [`${base}/b/feature.module.ts`, featureModule],
    [`${base}/app.module.ts`, appModule],
  ]);
  const opts = { rootModuleFile: `${base}/app.module.ts`, rootModuleClass: "AppModule" };
  const result = analyseSources(sources, opts);

  assert("a known-orphan emitted type is rejected", result.orphans.includes("test.event.orphaned"));
  assert("a literal emission is detected", result.allEmitted.has("test.event.orphaned"));
  assert(
    "an emission through a module const is resolved, not dropped",
    result.allEmitted.has("accounting.invoice.reminder.due"),
  );
  assert(
    "a REGISTERED readonly-eventType consumer clears its emission",
    !result.orphans.includes("accounting.invoice.reminder.due"),
  );
  assert(
    "an inline registry.register({ eventType }) in a registered provider clears its emission",
    !result.orphans.includes("test.event.inline-consumed"),
  );

  // The core regression. Under the old literal-matching gate every one of these passed.
  assert(
    "a consumer class that NO module provides is reported as an orphan",
    result.orphans.includes("test.event.declared-but-unwired"),
  );
  assert(
    "the unwired consumer is named as unregistered",
    result.unregisteredOnly.some((c) => c.className === "UnwiredConsumer"),
  );
  assert(
    "the unwired consumer's declared type is NOT counted as consumed",
    !result.allConsumed.has("test.event.declared-but-unwired"),
  );
  assert(
    "the unwired consumer IS counted as declared — declared and consumed are different questions",
    result.allDeclared.has("test.event.declared-but-unwired"),
  );
  assert("exactly the two true orphans are reported", result.orphans.length === 2);
  assert(
    "a registered consumer is not reported as unregistered",
    !result.unregisteredConsumers.some((c) => c.className === "ReminderConsumer"),
  );
  assert(
    "an unresolvable eventType identifier is dropped rather than reported as an orphan",
    !result.orphans.includes("COMPUTED_AT_RUNTIME"),
  );
  assert(
    "the const map picked up the module const",
    result.constMap.get("REMINDER_DUE") === "accounting.invoice.reminder.due",
  );
  assert(
    "the orphan is attributed to the file that emitted it",
    [...result.emittedByFile.get(`${base}/a/emitter.service.ts`)].includes("test.event.orphaned"),
  );

  // A module nobody imports from AppModule does not register anything, even though its
  // @Module block lists the provider.
  const detachedSources = new Map(sources);
  detachedSources.set(
    `${base}/app.module.ts`,
    '@Module({ imports: [], providers: [] })\nexport class AppModule {}',
  );
  const detached = analyseSources(detachedSources, opts);
  assert(
    "a provider in a module unreachable from AppModule counts as unregistered",
    detached.orphans.includes("accounting.invoice.reminder.due"),
  );

  // Registration must survive the consumer being provided by a module two hops down.
  const nestedSources = new Map(sources);
  nestedSources.set(
    `${base}/b/feature.module.ts`,
    'import { ReminderConsumer } from "./consumer";\nimport { InlineConsumer } from "./inline";\n@Module({ imports: [], providers: [ReminderConsumer, InlineConsumer] })\nexport class FeatureModule {}',
  );
  nestedSources.set(
    `${base}/mid.module.ts`,
    'import { FeatureModule } from "./b/feature.module";\n@Module({ imports: [FeatureModule] })\nexport class MidModule {}',
  );
  nestedSources.set(
    `${base}/app.module.ts`,
    'import { MidModule } from "./mid.module";\n@Module({ imports: [MidModule], providers: [] })\nexport class AppModule {}',
  );
  assert(
    "registration is followed transitively through nested module imports",
    !analyseSources(nestedSources, opts).orphans.includes("accounting.invoice.reminder.due"),
  );

  // `imports: BUILD_MODULES` — a hoisted array const rather than an inline literal. Build, KB,
  // Finance, HR and Inventory all do this, and failing to resolve it reported six false orphans.
  const constArraySources = new Map(sources);
  constArraySources.set(
    `${base}/b/feature.module.ts`,
    'import { ReminderConsumer } from "./consumer";\nimport { InlineConsumer } from "./inline";\nconst FEATURE_PROVIDERS = [ReminderConsumer, InlineConsumer];\n@Module({ providers: FEATURE_PROVIDERS })\nexport class FeatureModule {}',
  );
  constArraySources.set(
    `${base}/app.module.ts`,
    'import { FeatureModule } from "./b/feature.module";\nconst ROOT_MODULES = [FeatureModule];\n@Module({ imports: ROOT_MODULES, providers: [] })\nexport class AppModule {}',
  );
  const constArray = analyseSources(constArraySources, opts);
  assert(
    "a module list hoisted into `imports: SOME_CONST` is still followed",
    !constArray.orphans.includes("accounting.invoice.reminder.due"),
  );
  assert(
    "a provider list hoisted into `providers: SOME_CONST` still registers",
    !constArray.orphans.includes("test.event.inline-consumed"),
  );

  // A spread of one array const into another must expand, not read as a module class.
  const spreadSources = new Map(sources);
  spreadSources.set(
    `${base}/app.module.ts`,
    'import { FeatureModule } from "./b/feature.module";\nconst CHILD = [FeatureModule];\n@Module({ imports: [...CHILD], providers: [] })\nexport class AppModule {}',
  );
  assert(
    "a spread array const inside an inline imports array expands",
    !analyseSources(spreadSources, opts).orphans.includes("accounting.invoice.reminder.due"),
  );

  // Two modules may share a class name; the import path is what disambiguates them.
  const collidingSources = new Map([
    [`${base}/x/thing.consumer.ts`, 'export class XConsumer { readonly eventType = "collide.x"; }'],
    [
      `${base}/x/shared.module.ts`,
      'import { XConsumer } from "./thing.consumer";\n@Module({ providers: [XConsumer] })\nexport class SharedModule {}',
    ],
    [`${base}/y/shared.module.ts`, '@Module({ providers: [] })\nexport class SharedModule {}'],
    [
      `${base}/app.module.ts`,
      'import { SharedModule } from "./y/shared.module";\n@Module({ imports: [SharedModule] })\nexport class AppModule {}\nOutboxWriter.emit(tx, { eventType: "collide.x" });',
    ],
  ]);
  assert(
    "importing the same-named module from another folder does not register the other one's providers",
    analyseSources(collidingSources, opts).orphans.includes("collide.x"),
  );

  // Test files are excluded from the corpus entirely. A spec that merely mentions the consumer
  // shape — this gate's own durability spec greps for `readonly eventType = "..."` — must not read
  // as a declaration, and a consumer that exists only in a spec must not clear a real emission.
  assert("a .spec.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/foo.spec.ts"));
  assert("an .e2e-spec.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/foo.e2e-spec.ts"));
  assert("a file under __tests__/ is not a runtime source", !isRuntimeSource("/repo/src/a/__tests__/foo.ts"));
  assert("a .d.ts file is not a runtime source", !isRuntimeSource("/repo/src/a/foo.d.ts"));
  assert("an ordinary service IS a runtime source", isRuntimeSource("/repo/src/a/foo.service.ts"));
  assert("a module file IS a runtime source", isRuntimeSource("/repo/src/a/foo.module.ts"));

  const empty = analyseSources(new Map(), opts);
  assert("an empty corpus yields no findings", empty.orphans.length === 0);
  assert(
    "an empty corpus would trip the vacuity floor",
    isVacuous(0, empty.allEmitted.size, empty.allConsumed.size, empty.registeredProviders.size),
  );
  assert(
    "a real-sized scan does not trip the vacuity floor",
    !isVacuous(MIN_FILES, MIN_EMITTED, MIN_CONSUMED, MIN_REGISTERED_PROVIDERS),
  );
  assert(
    "the provider floor trips when the module graph fails to resolve",
    isVacuous(MIN_FILES, MIN_EMITTED, MIN_CONSUMED, 0),
  );

  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    console.error(`check-outbox-consumers self-tests: ${failures.length} failed, ${passed} passed`);
    process.exit(1);
  }
  console.log(`check-outbox-consumers self-tests: ${passed} passed`);
  process.exit(0);
}

if (SELF_TEST) runSelfTest();

const allFiles = collectTsFiles(SRC_ROOT);
const sourceByFile = new Map(allFiles.map((f) => [f, readFileSync(f, "utf8")]));
const {
  allEmitted,
  allConsumed,
  allDeclared,
  orphans,
  emittedByFile,
  unregisteredOnly,
  registeredProviders,
  reachableModules,
} = analyseSources(sourceByFile);

const rel = (f) => f.replace(SRC_ROOT + "/", "");

console.log(`Scanned ${allFiles.length} TypeScript files`);
console.log(
  `Module graph: ${reachableModules.size} modules reachable from ${ROOT_MODULE_CLASS}, ${registeredProviders.size} registered providers`,
);
console.log(`Emitted event types    (${allEmitted.size}): ${[...allEmitted].join(", ") || "(none)"}`);
console.log(`Declared event types   (${allDeclared.size}): ${[...allDeclared].join(", ") || "(none)"}`);
console.log(`REGISTERED event types (${allConsumed.size}): ${[...allConsumed].join(", ") || "(none)"}`);

if (isVacuous(allFiles.length, allEmitted.size, allConsumed.size, registeredProviders.size)) {
  console.error(
    `\nINCONCLUSIVE — scanned ${allFiles.length} files (floor ${MIN_FILES}) finding ${allEmitted.size} emitted (floor ${MIN_EMITTED}), ${allConsumed.size} registered-consumed (floor ${MIN_CONSUMED}) event types across ${registeredProviders.size} registered providers (floor ${MIN_REGISTERED_PROVIDERS}). "No orphans" over an empty scan proves nothing.`,
  );
  process.exit(2);
}

let failed = false;

if (orphans.length > 0) {
  failed = true;
  console.error("\nFAIL — orphaned event types (emitted, but no REGISTERED consumer handles them):");
  for (const type of orphans) {
    console.error(`  ${type}`);
    for (const [f, s] of emittedByFile) if (s.has(type)) console.error(`    emitted in: ${rel(f)}`);
    for (const c of unregisteredOnly)
      if (c.eventType === type)
        console.error(
          `    declared but NOT registered: ${c.className ?? "(anonymous)"} in ${rel(c.file)}`,
        );
  }
  console.error(
    "\nFix: add the consumer class to the `providers` of a @Module reachable from AppModule,",
  );
  console.error("or delete the consumer and its emitter together.");
}

if (unregisteredOnly.length > 0) {
  failed = true;
  console.error("\nFAIL — consumer declarations that never register at runtime:");
  for (const c of unregisteredOnly)
    console.error(
      `  ${c.className ?? "(anonymous)"} (${c.eventType}, ${c.kind}) — ${rel(c.file)}`,
    );
  console.error(
    "\nA class no @Module provides never has onModuleInit called, so it never reaches",
  );
  console.error("OutboxConsumerRegistry. Wire it, or delete it.");
}

if (failed) process.exit(1);

console.log("\nOK — every emitted outbox event type has a consumer registered from AppModule");
