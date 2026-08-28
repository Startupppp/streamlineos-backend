import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SOURCE_ROOT = __dirname;

interface Orphan {
  name: string;
  file: string;
}

function walkFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) found.push(...walkFiles(p));
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) found.push(p);
  }
  return found;
}

function detectUnregisteredInjectables(sources: Map<string, string>): Orphan[] {
  const injectables = new Map<string, string>();
  for (const [file, src] of sources) {
    if (/\.spec\.ts$/.test(file)) continue;
    const re = /@Injectable\(\s*(?:\{[^}]*\})?\s*\)\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) injectables.set(m[1], file);
  }

  const orphans: Orphan[] = [];
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
  return orphans;
}

function loadSources(): Map<string, string> {
  const sources = new Map<string, string>();
  for (const file of walkFiles(SOURCE_ROOT)) {
    sources.set(file.split("\\").join("/"), readFileSync(file, "utf8"));
  }
  return sources;
}

describe("unregistered injectables", () => {
  it("scans enough injectables so a broken walk cannot pass vacuously", () => {
    const sources = loadSources();
    const injectableCount = [...sources.entries()]
      .filter(([file]) => !/\.spec\.ts$/.test(file))
      .reduce((n, [, src]) => {
        const re = /@Injectable\(\s*(?:\{[^}]*\})?\s*\)\s*(?:export\s+)?class\s+([A-Za-z0-9_]+)/g;
        let count = 0;
        while (re.exec(src) !== null) count++;
        return n + count;
      }, 0);
    expect(injectableCount).toBeGreaterThan(200);
  });

  it("reports zero @Injectable classes that are unreferenced outside their own file", () => {
    const sources = loadSources();
    const orphans = detectUnregisteredInjectables(sources);
    const report = orphans
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((o) => `${o.name}  ${o.file}`)
      .join("\n");
    expect(report).toBe("");
  });

  it("detects a synthetic unregistered injectable so the mechanism is proven to bite", () => {
    const declFile = "synthetic/unregistered.service.ts";
    const otherFile = "synthetic/other.module.ts";
    const syntheticSources = new Map<string, string>([
      [declFile, "@Injectable()\nexport class SyntheticOrphanService {}"],
      [otherFile, "export class SomeOtherModule {}"],
    ]);
    const orphans = detectUnregisteredInjectables(syntheticSources);
    const names = orphans.map((o) => o.name);
    expect(names).toContain("SyntheticOrphanService");
  });
});
