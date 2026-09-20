import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");
const MODULES = join(SRC, "modules");

const READ_DECORATOR = /^\s*@(Get|Head|Options)\s*\(/;
const WRITE_DECORATOR = /^\s*@(Post|Put|Patch|Delete|All|Sse)\s*\(/;
const OPT_OUT = /^\s*@NoTenantTransaction\s*\(/;
const PUBLIC_ROUTE = /^\s*@Public\s*\(/;
const HANDLER = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const CONSTRUCTOR_PARAM =
  /(?:private|public|protected|readonly)\s+(?:readonly\s+)?([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)/;
const METHOD_CALL = /this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
const DB_WRITE =
  /\b(?:this\.db|db|tx|trx|executor|outer)\s*\.\s*(?:insert|update|delete)\s*\(|onConflictDo(?:Update|Nothing)\s*\(/;
const RAW_DML = /sql\s*`[^`]*\b(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM)/i;
const ESCAPE_HATCH = "runInNewTenantTransaction";

const MAX_HOPS = 3;
const MIN_CONTROLLERS = 200;
const MIN_READ_ROUTES = 800;

const FROZEN = new Set([
  "modules/payroll/insights/journal-outbox.controller.ts#exportCsv",
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
      continue;
    }
    if (extname(full) === ".ts") out.push(full);
  }
  return out;
}

function isSpec(file) {
  return /\.(spec|e2e-spec)\.ts$/.test(file);
}

export function stripEscapedRegions(body) {
  let out = "";
  let index = 0;
  while (index < body.length) {
    const at = body.indexOf(ESCAPE_HATCH, index);
    if (at === -1) {
      out += body.slice(index);
      break;
    }
    out += body.slice(index, at);
    let cursor = body.indexOf("(", at);
    if (cursor === -1) break;
    let depth = 0;
    while (cursor < body.length) {
      if (body[cursor] === "(") depth++;
      else if (body[cursor] === ")") {
        depth--;
        if (depth === 0) break;
      }
      cursor++;
    }
    index = cursor + 1;
  }
  return out;
}

export function writesDirectly(body) {
  const visible = stripEscapedRegions(body);
  return DB_WRITE.test(visible) || RAW_DML.test(visible);
}

export function blockAfter(lines, start) {
  const text = lines.slice(start).join("\n");
  let cursor = 0;
  let paren = 0;
  let opened = false;

  while (cursor < text.length) {
    const char = text[cursor];
    if (char === "(") {
      paren++;
      opened = true;
    } else if (char === ")") {
      paren--;
      if (opened && paren === 0) {
        cursor++;
        break;
      }
    }
    cursor++;
  }

  let angle = 0;
  let bodyStart = -1;
  for (; cursor < text.length; cursor++) {
    const char = text[cursor];
    if (char === "<") angle++;
    else if (char === ">") {
      if (angle > 0) angle--;
    } else if (char === ";" && angle === 0) return "";
    else if (char === "{" && angle === 0) {
      bodyStart = cursor;
      break;
    }
  }
  if (bodyStart === -1) return "";

  let depth = 0;
  let end = bodyStart;
  for (; end < text.length; end++) {
    if (text[end] === "{") depth++;
    else if (text[end] === "}") {
      depth--;
      if (depth === 0) {
        end++;
        break;
      }
    }
  }
  return text.slice(bodyStart, end);
}

export function findReadRoutes(source) {
  const lines = source.split("\n");
  const classLine = lines.findIndex((line) => /^export (?:abstract )?class /.test(line));
  if (classLine !== -1) {
    const preamble = lines.slice(0, classLine);
    if (preamble.some((line) => OPT_OUT.test(line) || PUBLIC_ROUTE.test(line))) return [];
  }

  const routes = [];
  let pendingRead = false;
  let pendingWrite = false;
  let pendingOptOut = false;
  let pendingPublic = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (READ_DECORATOR.test(line)) {
      pendingRead = true;
      continue;
    }
    if (WRITE_DECORATOR.test(line)) {
      pendingWrite = true;
      continue;
    }
    if (OPT_OUT.test(line)) {
      pendingOptOut = true;
      continue;
    }
    if (PUBLIC_ROUTE.test(line)) {
      pendingPublic = true;
      continue;
    }
    if (/^\s*@/.test(line) || line.trim() === "") continue;

    if (pendingRead || pendingWrite) {
      const handler = HANDLER.exec(line);
      if (handler) {
        if (pendingRead && !pendingWrite && !pendingOptOut && !pendingPublic)
          routes.push({ handler: handler[1], body: blockAfter(lines, i) });
        pendingRead = false;
        pendingWrite = false;
        pendingOptOut = false;
        pendingPublic = false;
      }
    }
  }

  return routes;
}

export function injectedTypes(source) {
  const map = new Map();
  const start = source.indexOf("constructor(");
  if (start === -1) return map;
  const slice = source.slice(start, source.indexOf(")", start) === -1 ? undefined : undefined);
  const lines = source.slice(start).split("\n");
  let depth = 0;
  let seen = false;
  for (const line of lines) {
    const found = CONSTRUCTOR_PARAM.exec(line);
    if (found) map.set(found[1], found[2]);
    for (const char of line) {
      if (char === "(") {
        depth++;
        seen = true;
      } else if (char === ")") depth--;
    }
    if (seen && depth <= 0) break;
  }
  void slice;
  return map;
}

function buildClassIndex(files) {
  const index = new Map();
  for (const file of files) {
    if (isSpec(file)) continue;
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^export (?:abstract )?class ([A-Za-z_$][\w$]*)/gm))
      if (!index.has(match[1])) index.set(match[1], file);
  }
  return index;
}

function methodBody(source, name) {
  const lines = source.split("\n");
  const pattern = new RegExp(
    `^\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:async\\s+)?${name}\\s*\\(`,
  );
  for (let i = 0; i < lines.length; i++)
    if (pattern.test(lines[i])) return blockAfter(lines, i);
  return null;
}

function reaches(body, classIndex, sourceOf, hops, seen) {
  if (writesDirectly(body)) return true;
  if (hops >= MAX_HOPS) return false;

  const visible = stripEscapedRegions(body);
  for (const call of visible.matchAll(METHOD_CALL)) {
    const [, prop, method] = call;
    const owner = sourceOf.types.get(prop);
    if (!owner) continue;
    const file = classIndex.get(owner);
    if (!file) continue;
    const key = `${owner}#${method}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const source = readFileSync(file, "utf8");
    const nested = methodBody(source, method);
    if (nested === null) continue;
    if (
      reaches(
        nested,
        classIndex,
        { types: injectedTypes(source) },
        hops + 1,
        seen,
      )
    )
      return true;
  }
  return false;
}

function scan() {
  const all = walk(SRC);
  const classIndex = buildClassIndex(all);
  const controllers = walk(MODULES).filter(
    (file) => /\.controller\.ts$/.test(file) && !isSpec(file),
  );

  const writing = [];
  let readRoutes = 0;

  for (const file of controllers) {
    const source = readFileSync(file, "utf8");
    const routes = findReadRoutes(source);
    if (routes.length === 0) continue;
    const types = injectedTypes(source);
    const rel = relative(SRC, file).replace(/\\/g, "/");

    for (const route of routes) {
      readRoutes++;
      if (reaches(route.body, classIndex, { types }, 0, new Set()))
        writing.push(`${rel}#${route.handler}`);
    }
  }

  return {
    controllers: controllers.length,
    readRoutes,
    writing: [...new Set(writing)].sort(),
  };
}

function selfTest() {
  const failures = [];

  const routes = findReadRoutes(`
  @Get("settings")
  async getSettings() {
    return this.settings.get(orgId);
  }

  @Post("settings")
  async updateSettings() {
    await this.db.insert(table).values({});
  }
`);
  if (routes.length !== 1) failures.push(`found ${routes.length} read routes, expected 1`);
  else if (routes[0].handler !== "getSettings")
    failures.push(`picked ${routes[0].handler} instead of getSettings`);

  const optedOut = findReadRoutes(`
  @Get("download")
  @NoTenantTransaction()
  async download() {}
`);
  if (optedOut.length !== 0) failures.push("counted a route that opts out of the tenant transaction");

  const publicRoute = findReadRoutes(`
  @Get(":slug")
  @Public()
  async readArticle() {}
`);
  if (publicRoute.length !== 0)
    failures.push("counted a @Public route, which never opens a tenant transaction");

  const publicClass = findReadRoutes(`
@Public()
@Controller("public")
export class PublicController {
  @Get("kb/:slug")
  async getArticle() {}
}
`);
  if (publicClass.length !== 0)
    failures.push(
      "counted a route under a class-level @Public, where resolveTenant returns null and no transaction opens",
    );

  const optedOutClass = findReadRoutes(`
@NoTenantTransaction()
@Controller("storage")
export class StorageController {
  @Get("download")
  async download() {}
}
`);
  if (optedOutClass.length !== 0)
    failures.push("counted a route under a class-level @NoTenantTransaction");

  if (!writesDirectly("await this.db.insert(table).values({});"))
    failures.push("missed a direct insert");
  if (!writesDirectly("await tx.update(table).set({ a: 1 });"))
    failures.push("missed an update on a tx handle");
  if (!writesDirectly("await db.insert(t).values(v).onConflictDoNothing();"))
    failures.push("missed an upsert");
  if (!writesDirectly("await tx.execute(sql`UPDATE batches SET status = 'X'`);"))
    failures.push("missed raw DML");

  if (writesDirectly("this.cache.delete(key);"))
    failures.push("counted a cache delete as a database write");
  if (writesDirectly("seen.delete(id); map.update = 1;"))
    failures.push("counted an in-memory delete as a database write");
  if (writesDirectly("await runInNewTenantTransaction(this.db, orgId, () => this.db.insert(t).values(v));"))
    failures.push("counted a write that already escapes the request transaction");

  if (!writesDirectly("await runInNewTenantTransaction(db, org, () => x()); await this.db.insert(t).values(v);"))
    failures.push("an escaped write hid a second, unescaped one on the same path");

  const decoratedParams = blockAfter(
    [
      '  async exportCsv(',
      '    @Param("batchId", ParseIntPipe) batchId: number,',
      '    @Res({ passthrough: true }) res: Response,',
      "  ) {",
      "    await this.outbox.markExported(orgId, userId, batchId);",
      "  }",
    ],
    0,
  );
  if (!/markExported/.test(decoratedParams))
    failures.push(
      "a decorator object literal in the parameter list closed the body before it began",
    );

  const objectReturnType = blockAfter(
    [
      "  async getUploadedLetter(",
      "    id: number,",
      "  ): Promise<{ url: string; expiresIn: number }> {",
      "    await this.audit.logCritical({});",
      "  }",
    ],
    0,
  );
  if (!/logCritical/.test(objectReturnType))
    failures.push("an object literal inside the return type was mistaken for the method body");

  const types = injectedTypes(`
export class DemoController {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly settings: SignSettingsService,
  ) {}
}
`);
  if (types.get("settings") !== "SignSettingsService")
    failures.push("failed to resolve an injected service to its class");

  const live = scan();
  if (live.controllers < MIN_CONTROLLERS)
    failures.push(`reached only ${live.controllers} controllers — the walk has stopped finding them`);
  if (live.readRoutes < MIN_READ_ROUTES)
    failures.push(`reached only ${live.readRoutes} read routes — a zero here would be vacuous`);

  return failures;
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes("--self-test")) {
    const failures = selfTest();
    if (failures.length > 0) {
      console.error("check-get-route-writes self-test FAILED:");
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exit(3);
    }
    console.log("check-get-route-writes self-test passed");
    return;
  }

  const result = scan();

  if (args.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (result.controllers < MIN_CONTROLLERS || result.readRoutes < MIN_READ_ROUTES) {
    console.error(
      `check-get-route-writes: reached ${result.controllers} controllers and ${result.readRoutes} read routes — ` +
        "below the floor. A pass here would be vacuous; fix the scan, not the floor.",
    );
    process.exit(2);
  }

  const added = result.writing.filter((route) => !FROZEN.has(route));
  const stale = [...FROZEN].filter((route) => !result.writing.includes(route));

  if (stale.length > 0) {
    console.error(
      "check-get-route-writes: these read routes no longer write — remove them from FROZEN so the ratchet holds:",
    );
    for (const route of stale) console.error(`  - ${route}`);
    process.exit(1);
  }

  if (added.length > 0) {
    console.error(
      `check-get-route-writes: ${added.length} read route(s) write inside the request transaction.\n` +
        "A read-only Postgres transaction fails 25006 on any INSERT/UPDATE/DELETE, so this blocks\n" +
        "read-replica routing and accessMode read-only. Move the write into runInNewTenantTransaction,\n" +
        "or stop writing on the read.\n",
    );
    for (const route of added) console.error(`  - ${route}`);
    process.exit(1);
  }

  console.log(
    `check-get-route-writes: ${result.readRoutes} read route(s) across ${result.controllers} controller(s); ` +
      `${result.writing.length} still writing inside the request transaction (frozen).`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
