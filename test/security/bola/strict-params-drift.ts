import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A route whose `@Validate({ params })` schema is `.strict()` but does not name every parameter the
 * route's path actually carries.
 *
 * `req.params` holds the parameters from the WHOLE path — the `@Controller` prefix included — so a
 * `.strict()` schema listing only the handler's own segment rejects the parent's. The route then
 * answers 400 to every caller, its own tenant included, and it does so from the validation
 * interceptor before any handler code runs. Nothing about the caller, the body or the ids changes
 * the outcome: the route cannot be used at all.
 *
 * Found while re-probing the 468 routes the live sweep had filed as "the probe sends no body". A
 * body was never going to fix these, and they had been sitting inside a bucket whose label said it
 * would. That is why this is a detector and not a note: the same defect is invisible to a passing
 * unit test (`isolatedModules` never runs the interceptor), to `tsc`, and to any sweep that reads a
 * control 400 as "unprobeable" rather than "broken".
 */

const BACKEND_ROOT = resolve(__dirname, "..", "..", "..");
const SRC_ROOT = join(BACKEND_ROOT, "src");

export interface StrictParamsFinding {
  readonly file: string;
  readonly line: number;
  readonly route: string;
  readonly schema: string;
  readonly declared: readonly string[];
  readonly missing: readonly string[];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (entry.endsWith(".controller.ts")) out.push(abs);
  }
  return out;
}

const PARAM_RE = /:([A-Za-z0-9_]+)/g;

export function pathParamsOf(path: string): string[] {
  return [...path.matchAll(PARAM_RE)].map((m) => m[1] as string);
}

/** `const xParams = z.object({ a: …, b: … }).strict();` — keys and whether the object is strict. */
export function parseParamSchemas(source: string): Map<string, { keys: string[]; strict: boolean }> {
  const out = new Map<string, { keys: string[]; strict: boolean }>();
  const declaration = /const\s+(\w+)\s*=\s*z\s*\.object\s*\(\s*\{([\s\S]*?)\}\s*\)\s*(\.strict\(\))?/g;
  for (const match of source.matchAll(declaration)) {
    const name = match[1] as string;
    const inner = match[2] as string;
    const keys = [...inner.matchAll(/(?:^|,)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/g)].map(
      (k) => (k[1] ?? k[2] ?? k[3]) as string,
    );
    out.set(name, { keys, strict: match[3] !== undefined });
  }
  return out;
}

const CONTROLLER_RE = /@Controller\s*\(\s*(?:["'`]([^"'`]*)["'`])?/;
const VERB_RE = /@(Get|Post|Put|Patch|Delete)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/;
const VALIDATE_PARAMS_RE = /@Validate\s*\(\s*\{[^}]*\bparams\s*:\s*(\w+)/;

function joinPath(prefix: string, sub: string): string {
  const parts = [prefix, sub].filter((p) => p.length > 0).join("/");
  return `/${parts.replace(/\/+/g, "/").replace(/^\/|\/$/g, "")}`;
}

export function findStrictParamsDrift(files: readonly string[] = walk(SRC_ROOT)): StrictParamsFinding[] {
  const findings: StrictParamsFinding[] = [];
  for (const abs of files) {
    const source = readFileSync(abs, "utf8");
    if (!source.includes("@Validate")) continue;
    const schemas = parseParamSchemas(source);
    const lines = source.split("\n");
    let prefix = "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] as string;
      const controller = CONTROLLER_RE.exec(line);
      if (controller) {
        prefix = controller[1] ?? "";
        continue;
      }
      const verb = VERB_RE.exec(line);
      if (!verb) continue;
      // The decorators of one handler sit together; six lines covers every shape in this codebase.
      const window = lines.slice(i, i + 7).join("\n");
      const validate = VALIDATE_PARAMS_RE.exec(window);
      if (!validate) continue;
      const schema = schemas.get(validate[1] as string);
      if (!schema || !schema.strict) continue;
      const path = joinPath(prefix, verb[2] ?? "");
      const missing = pathParamsOf(path).filter((param) => !schema.keys.includes(param));
      if (missing.length === 0) continue;
      findings.push({
        file: relative(BACKEND_ROOT, abs).replace(/\\/g, "/"),
        line: i + 1,
        route: `${(verb[1] as string).toUpperCase()} ${path}`,
        schema: validate[1] as string,
        declared: schema.keys,
        missing,
      });
    }
  }
  return findings.sort((a, b) => a.route.localeCompare(b.route));
}
