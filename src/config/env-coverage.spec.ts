import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_VARIABLE_NAMES, validateEnv } from "./env.validation";

const SOURCE_ROOTS = ["modules", "common"];

/** Read before the injector exists, so injecting them buys nothing. */
const ALLOWED_OUTSIDE_THE_SCHEMA: Record<string, string> = {
  NODE_ENV: "Read by tooling, test setup and framework code before the container is built.",
  npm_package_version: "Injected by the package manager, not by deployment.",
};

const ENV_READ = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\])/g;

function isTestFile(path: string): boolean {
  return (
    path.includes("__tests__") ||
    /\.(spec|e2e-spec|test)\.ts$/.test(path) ||
    path.includes(`${"test"}${"/"}`) ||
    path.includes("\\test\\")
  );
}

function sourceFilesUnder(root: string): string[] {
  const base = resolve(__dirname, "..", root);
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!full.endsWith(".ts")) continue;
      if (isTestFile(full)) continue;
      found.push(full);
    }
  };
  walk(base);
  return found;
}

function readsByVariable(): Map<string, string[]> {
  const reads = new Map<string, string[]>();
  for (const root of SOURCE_ROOTS) {
    for (const file of sourceFilesUnder(root)) {
      const contents = readFileSync(file, "utf8");
      for (const match of contents.matchAll(ENV_READ)) {
        const name = match[1] ?? match[2];
        if (!name) continue;
        const seen = reads.get(name) ?? [];
        seen.push(file);
        reads.set(name, seen);
      }
    }
  }
  return reads;
}

describe("every variable the application reads is a variable the schema validates", () => {
  const reads = readsByVariable();

  it("finds the environment reads it is meant to be checking", () => {
    expect(reads.size).toBeGreaterThan(10);
  });

  it("validates every variable read in application code", () => {
    const known = new Set([
      ...CONFIG_VARIABLE_NAMES,
      ...Object.keys(ALLOWED_OUTSIDE_THE_SCHEMA),
    ]);
    const unvalidated = [...reads.entries()]
      .filter(([name]) => !known.has(name))
      .map(([name, files]) => `${name} (${files.length} read(s), e.g. ${files[0]})`)
      .sort();

    expect(unvalidated).toEqual([]);
  });

  it("gives every exception a reason", () => {
    const unexplained = Object.entries(ALLOWED_OUTSIDE_THE_SCHEMA)
      .filter(([, reason]) => reason.trim().length === 0)
      .map(([name]) => name);

    expect(unexplained).toEqual([]);
  });
});

describe("the operator-facing contract lists every variable", () => {
  const example = readFileSync(resolve(__dirname, "..", "..", ".env.example"), "utf8");
  const documented = new Set(
    [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(
      (match) => match[1] ?? "",
    ),
  );

  it("documents every variable the schema validates", () => {
    const undocumented = CONFIG_VARIABLE_NAMES.filter(
      (name) => !documented.has(name),
    ).sort();

    expect(undocumented).toEqual([]);
  });
});

describe("a bad environment stops the boot", () => {
  const valid = {
    DATABASE_URL: "postgres://user:pass@host/db",
    BACKEND_JWT_SECRET: "a".repeat(44),
    PORTAL_JWT_SECRET: "b".repeat(44),
    CORS_ORIGINS: "https://app.example.com",
    APP_URL: "https://app.example.com",
    ENCRYPTION_KEY: "c".repeat(32),
  };

  it("accepts an environment that satisfies the schema", () => {
    expect(() => validateEnv(valid)).not.toThrow();
  });

  it("names the variable that is missing", () => {
    const { ENCRYPTION_KEY: _omitted, ...withoutKey } = valid;
    expect(() => validateEnv(withoutKey)).toThrow(/ENCRYPTION_KEY/);
  });

  it("names the variable that is malformed", () => {
    expect(() => validateEnv({ ...valid, APP_URL: "not-a-url" })).toThrow(
      /APP_URL/,
    );
  });

  it("refuses a short unsubscribe secret rather than minting weak tokens", () => {
    expect(() =>
      validateEnv({ ...valid, UNSUBSCRIBE_TOKEN_SECRET: "too-short" }),
    ).toThrow(/UNSUBSCRIBE_TOKEN_SECRET/);
  });
});
