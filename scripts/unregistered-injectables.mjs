import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds @Injectable() classes that no module lists as a provider.
 *
 * Nest cannot instantiate such a class, so it is dead at runtime while tsc, nest build, madge and
 * the test suite all stay green. NotificationRetentionService sat like this -- the DETACH PARTITION
 * implementation a ticket required, registered nowhere.
 *
 * Output is CANDIDATES. A class can legitimately reach the container without appearing in a
 * `providers:` array -- custom providers, useClass/useFactory, dynamic modules, and classes
 * provided under an injection token. Confirm each hit before acting on it.
 */

const ROOT = process.argv[2] ?? "src";

const files = [];
(function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
  }
})(ROOT);

const sources = new Map();
for (const file of files) sources.set(file.split("\\").join("/"), readFileSync(file, "utf8"));

const injectables = new Map();
for (const [file, src] of sources) {
  if (/\.spec\.ts$/.test(file)) continue;
  // `abstract` is excluded deliberately: an abstract class is never itself a provider, it is a
  // base other providers extend. HrProjectionSource is exactly that, and counting it produced a
  // false positive.
  const re = /@Injectable\(\s*(?:\{[^}]*\})?\s*\)\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/g;
  let m;
  while ((m = re.exec(src)) !== null) injectables.set(m[1], file);
}

/**
 * Search for the ACTUAL collected names, never a suffix pattern. A first version matched only
 * names ending Service/Guard/... which meant ActionExecutor and ImportPump could not be found
 * anywhere and were reported dead by construction -- 54 candidates, most of them manufactured.
 */
const orphans = [];
for (const [name, declFile] of injectables) {
  const word = new RegExp(`\\b${name}\\b`);
  let seenElsewhere = false;
  for (const [file, src] of sources) {
    if (file === declFile) continue;
    if (word.test(src)) {
      seenElsewhere = true;
      break;
    }
  }
  if (!seenElsewhere) orphans.push({ name, file: declFile });
}

console.log(`injectables=${injectables.size} unreferencedOutsideOwnFile=${orphans.length}`);
for (const o of orphans.sort((a, b) => a.name.localeCompare(b.name)))
  console.log(`  ${o.name}  ${o.file}`);
