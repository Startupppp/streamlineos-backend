import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

const SRC_ROOT = join(__dirname, "..", "..");
const SCRIPTS_ROOT = join(SRC_ROOT, "scripts");

const CANONICAL = "common/rbac/module-vocabulary.ts";

/**
 * Every colon parser in production source that is NOT a permission key. Each
 * entry is proved still present below, so a file that gets fixed cannot leave a
 * silent exemption behind.
 */
const NOT_A_PERMISSION_KEY: Readonly<Record<string, string>> = {
  "common/openapi/zod-operation-contracts.ts":
    "OpenAPI parameter-type numbers keyed as `<type>:<name>`",
  "common/security/envelope-encryption.ts":
    "envelope ciphertext segments `prefix:alg:version:wrapped:body`",
  "common/security/ssrf-guard.ts": "IPv6 hextets",
  "modules/build/scope-directory/scope-directory.service.ts":
    "Build scope keys `product:<id>` and `project:<id>`",
  "modules/hr/time/attendance-summary.service.ts": "HH:MM shift times",
  "modules/hr/time/attendance-policy.service.ts": "HH:MM shift times",
  "modules/hr/lifecycle/hr-dashboard-attendance.ts": "HH:MM shift times",
  "modules/support/core/support-business-hours.util.ts": "HH:MM business hours",
};

const PARSER = /\.(?:split|indexOf)\(\s*(?:"\s*:\s*"|'\s*:\s*'|\/:\/)\s*\)/;

interface SourceFile {
  path: string;
  text: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__tests__") continue;
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".mjs")) continue;
    if (entry.endsWith(".spec.ts") || entry.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out;
}

function productionSources(): SourceFile[] {
  return walk(SRC_ROOT)
    .filter((full) => !full.startsWith(SCRIPTS_ROOT + sep))
    .map((full) => ({
      path: relative(SRC_ROOT, full).split(sep).join("/"),
      text: readFileSync(full, "utf8"),
    }));
}

export function findPrivateKeyParsers(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    if (file.path === CANONICAL) continue;
    if (file.path in NOT_A_PERMISSION_KEY) continue;
    file.text.split("\n").forEach((line, index) => {
      if (PARSER.test(line)) found.push(`${file.path}:${index + 1}`);
    });
  }
  return found;
}

describe("no private permission-key parser in production policy code", () => {
  const files = productionSources();

  it("scanned a real tree, so an empty result means something", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some((file) => file.path === CANONICAL)).toBe(true);
  });

  it("bites on a reintroduced private parser", () => {
    expect(
      findPrivateKeyParsers([
        { path: "modules/made-up/x.service.ts", text: 'const m = key.split(":")[0];' },
      ]),
    ).toEqual(["modules/made-up/x.service.ts:1"]);
    expect(
      findPrivateKeyParsers([
        {
          path: "modules/made-up/y.service.ts",
          text: "const i = key.indexOf(':');\nconst ns = key.slice(0, i);",
        },
      ]),
    ).toEqual(["modules/made-up/y.service.ts:1"]);
  });

  it("does not bite on the canonical file or on an allowlisted path", () => {
    expect(
      findPrivateKeyParsers([
        { path: CANONICAL, text: 'permissionKey.indexOf(":")' },
        { path: "common/security/ssrf-guard.ts", text: 'tail.split(":")' },
      ]),
    ).toEqual([]);
  });

  it("finds none outside the canonical helper and the allowlist", () => {
    expect(findPrivateKeyParsers(files)).toEqual([]);
  });

  // A stale exemption is a hole: the file was fixed, the allowlist kept excusing it, and the next parser added there is invisible.
  it("keeps no allowlist entry that no longer parses a colon", () => {
    const stale = Object.keys(NOT_A_PERMISSION_KEY).filter((path) => {
      const file = files.find((candidate) => candidate.path === path);
      return file === undefined || !PARSER.test(file.text);
    });

    expect(stale).toEqual([]);
  });
});

describe("no second namespace-to-module table", () => {
  const scripts = walk(SCRIPTS_ROOT).map((full) => ({
    path: relative(SRC_ROOT, full).split(sep).join("/"),
    text: readFileSync(full, "utf8"),
  }));

  it("scanned the scripts tree", () => {
    expect(scripts.length).toBeGreaterThan(20);
    expect(
      scripts.some((file) => file.path === "scripts/permission-key-extractors.mjs"),
    ).toBe(true);
  });

  it("declares administeringModuleOf and moduleOwningNamespace in exactly one script", () => {
    const declaring = scripts
      .filter((file) =>
        /(?:function|const)\s+(?:administeringModuleOf|moduleOwningNamespace)\b/.test(
          file.text,
        ),
      )
      .map((file) => file.path);

    expect(declaring).toEqual(["scripts/permission-key-extractors.mjs"]);
  });

  it("hand-codes the home-administered mapping nowhere", () => {
    const handCoded = [...productionSources(), ...scripts]
      .filter((file) =>
        /["']?(?:chat|mail|calendar|notifications)["']?\s*:\s*["']home["']/.test(
          file.text,
        ),
      )
      .map((file) => file.path);

    expect(handCoded).toEqual([]);
  });
});
