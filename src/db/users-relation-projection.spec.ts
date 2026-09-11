import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const SCHEMA = join(SRC, "db", "schema");

const SECRET_USER_COLUMNS = ["totpSecret", "emergencyContact", "dateOfBirth", "metadata"];

type RelationTarget = { target: string; kind: "one" | "many" };
type RelationMap = Record<string, Record<string, RelationTarget>>;
type Hydration = { file: string; line: number; path: string; projected: boolean; columns: string[] };

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
      continue;
    }
    if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

function closingBrace(source: string, openIndex: number, open = "{", close = "}"): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelEntries(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "{" || c === "[" || c === "(") depth++;
    else if (c === "}" || c === "]" || c === ")") depth--;
    else if (c === "," && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

function objectValue(body: string, key: string): { body: string } | null {
  const match = new RegExp(`(^|[\\s,{])${key}\\s*:\\s*\\{`).exec(body);
  if (!match) return null;
  const open = body.indexOf("{", match.index + match[0].length - 1);
  const close = closingBrace(body, open);
  if (close < 0) return null;
  return { body: body.slice(open + 1, close) };
}

function buildRelationMap(): RelationMap {
  const map: RelationMap = {};
  for (const file of walk(SCHEMA)) {
    const source = readFileSync(file, "utf8");
    const blocks = /relations\(\s*([A-Za-z_$][\w$]*)\s*,[\s\S]*?=>\s*\(\{/g;
    let block: RegExpExecArray | null;
    while ((block = blocks.exec(source)) !== null) {
      const table = block[1];
      const open = source.indexOf("{", block.index + block[0].length - 1);
      const close = closingBrace(source, open);
      if (close < 0) continue;
      const entries = /([A-Za-z_$][\w$]*)\s*:\s*(one|many)\s*\(\s*([A-Za-z_$][\w$]*)/g;
      let entry: RegExpExecArray | null;
      map[table] = map[table] ?? {};
      const forTable = map[table];
      if (!forTable) continue;
      const body = source.slice(open + 1, close);
      while ((entry = entries.exec(body)) !== null)
        forTable[entry[1] as string] = {
          target: entry[3] as string,
          kind: entry[2] as "one" | "many",
        };
    }
  }
  return map;
}

function inlineSharedObjectConstants(source: string): string {
  const constants = new Map<string, string>();
  const declarations = /const\s+([A-Z][A-Z0-9_]*)\s*=\s*\{/g;
  let declaration: RegExpExecArray | null;
  while ((declaration = declarations.exec(source)) !== null) {
    const open = source.indexOf("{", declaration.index);
    const close = closingBrace(source, open);
    if (close > 0) constants.set(declaration[1] as string, source.slice(open, close + 1));
  }
  return source.replace(/\b(with|columns)\s*:\s*([A-Z][A-Z0-9_]*)\b/g, (whole, key: string, name: string) => {
    const body = constants.get(name);
    return body === undefined ? whole : `${key}: ${body}`;
  });
}

function collectUsersHydrations(): { hits: Hydration[]; unresolved: string[]; querySites: number } {
  const relations = buildRelationMap();
  const hits: Hydration[] = [];
  const unresolved: string[] = [];
  let querySites = 0;

  const visit = (file: string, source: string, at: number, table: string, withBody: string, path: string): void => {
    for (const entry of topLevelEntries(withBody)) {
      const parsed = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]*)$/.exec(entry);
      if (!parsed) continue;
      const relation = parsed[1] as string;
      const rest = (parsed[2] as string).trim();
      const target = relations[table]?.[relation]?.target;
      const line = source.slice(0, at).split("\n").length;
      if (target === undefined) {
        unresolved.push(`${file}:${line} ${path}.${relation}`);
        continue;
      }
      if (rest.startsWith("true")) {
        if (target === "users") hits.push({ file, line, path: `${path}.${relation}`, projected: false, columns: [] });
        continue;
      }
      if (!rest.startsWith("{")) continue;
      const open = entry.indexOf("{", relation.length);
      const close = closingBrace(entry, open);
      const nested = entry.slice(open + 1, close);
      const columns = objectValue(nested, "columns");
      if (target === "users")
        hits.push({
          file,
          line,
          path: `${path}.${relation}`,
          projected: columns !== null,
          columns:
            columns === null
              ? []
              : topLevelEntries(columns.body)
                  .map((c) => (c.split(":")[0] ?? "").trim())
                  .filter(Boolean),
        });
      const deeper = objectValue(nested, "with");
      if (deeper !== null) visit(file, source, at, target, deeper.body, `${path}.${relation}`);
    }
  };

  for (const file of walk(SRC)) {
    if (file.endsWith(".spec.ts") || file.includes(`${join("", "__tests__")}`)) continue;
    const source = inlineSharedObjectConstants(readFileSync(file, "utf8"));
    const relativePath = file.slice(SRC.length + 1);
    const calls = /\bdb\.query\.([A-Za-z_$][\w$]*)\.(?:findMany|findFirst)\s*\(/g;
    let call: RegExpExecArray | null;
    while ((call = calls.exec(source)) !== null) {
      querySites++;
      const parenOpen = call.index + call[0].length - 1;
      const parenClose = closingBrace(source, parenOpen, "(", ")");
      const argOpen = source.indexOf("{", parenOpen);
      if (parenClose < 0 || argOpen < 0 || argOpen > parenClose) continue;
      const argClose = closingBrace(source, argOpen);
      if (argClose < 0 || argClose > parenClose) continue;
      const withBlock = objectValue(source.slice(argOpen + 1, argClose), "with");
      if (withBlock === null) continue;
      visit(relativePath, source, call.index, call[1] as string, withBlock.body, call[1] as string);
    }
  }
  return { hits, unresolved, querySites };
}

describe("global users relations are never hydrated unprojected", () => {
  const { hits, unresolved, querySites } = collectUsersHydrations();

  it("resolves a representative corpus rather than reporting a vacuous zero", () => {
    expect(querySites).toBeGreaterThan(1000);
    expect(hits.length).toBeGreaterThan(100);
    expect(unresolved).toEqual([]);
  });

  it("declares an explicit columns projection on every relation to global users", () => {
    const unprojected = hits.filter((hit) => !hit.projected);
    expect(unprojected.map((hit) => `${hit.file}:${hit.line} ${hit.path}`)).toEqual([]);
  });

  it("never projects an authentication secret or a legacy PII column off users", () => {
    const leaks = hits
      .flatMap((hit) => hit.columns.map((column) => ({ hit, column })))
      .filter(({ column }) => SECRET_USER_COLUMNS.includes(column));
    expect(leaks.map(({ hit, column }) => `${hit.file}:${hit.line} ${hit.path}.${column}`)).toEqual([]);
  });
});
