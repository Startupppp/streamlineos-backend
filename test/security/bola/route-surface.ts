import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export const BACKEND_ROOT = resolve(__dirname, "..", "..", "..");
const SRC_ROOT = join(BACKEND_ROOT, "src");

export type Classification =
  | "public"
  | "universal"
  | "permissioned"
  | "in-service"
  | "UNDECLARED";

export interface ServiceCall {
  readonly property: string;
  readonly method: string;
  readonly args: string;
}

export interface HandlerRoute {
  readonly file: string;
  readonly controllerClass: string;
  readonly handler: string;
  readonly verb: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly classification: Classification;
  readonly permissionKeys: readonly string[];
  readonly line: number;
  readonly signature: string;
  readonly body: string;
  readonly serviceCalls: readonly ServiceCall[];
  readonly injected: ReadonlyMap<string, string>;
}

const VERB_RE = /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:["'`]([^"'`]*)["'`])?/;
const CONTROLLER_RE = /@Controller\s*\(\s*(?:["'`]([^"'`]*)["'`])?/;
const CLASS_RE = /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
const PERMISSION_RE = /@RequirePermission\s*\(\s*["'`]([^"'`]+)["'`]/g;
const PERMISSION_ANY_RE = /@RequirePermission\s*\(\s*\S/;
const CONST_KEY_RE = /^\s*const\s+([A-Z][A-Z0-9_]*)\s*=\s*["'`]([^"'`]+)["'`]/;
const PERMISSION_CONST_RE = /@RequirePermission\s*\(\s*([A-Z][A-Z0-9_]*)\s*\)/;
const PUBLIC_RE = /@Public\s*\(\s*\)/;
const UNIVERSAL_RE = /@Universal\s*\(\s*\)/;
const IN_SERVICE_RE = /@AuthorizedInService\s*\(\s*["'`][^"'`]/;
const METHOD_RE = /^\s*(?:public\s+|private\s+|protected\s+)?(?:async\s+)?(\w+)\s*[(<]/;

/**
 * Only `constructor` is excluded. A reserved-word list used to sit here — the same list
 * `check:route-classification` carried until 053db5f39 removed it — and it silently dropped every
 * handler NAMED `delete`, `export`, `import` or `void`: 14 real routes on this branch, the delete
 * and export routes whose binding matters most. METHOD_RE is only ever tried on the first code
 * line after an HTTP-verb decorator block, where control flow cannot appear, so the list guarded
 * nothing; with it gone the walk and the gate enumerate the same handlers again.
 */
const KEYWORDS = new Set(["constructor"]);

function* walkControllers(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) yield* walkControllers(full);
    else if (entry.endsWith(".controller.ts")) yield full;
  }
}

export function joinRoutePath(base: string, sub: string): string {
  const combined = `/${base}/${sub}`.replace(/\/+/g, "/");
  return combined.length > 1 ? combined.replace(/\/$/, "") : "/";
}

export function extractPathParams(path: string): string[] {
  return [...path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1] as string);
}

/**
 * Maps injected constructor properties to their declared class type, for the
 * constructor at or after `from`. One file often declares several controllers
 * (`workspace.controller.ts` holds four); taking the file's first constructor
 * would give every one of them the first controller's dependencies, so a service
 * call would resolve to no class and the route would read as unauthorized.
 */
export function parseInjectedProperties(source: string, from = 0): Map<string, string> {
  const injected = new Map<string, string>();
  const ctor = source.indexOf("constructor(", from);
  if (ctor === -1) return injected;
  const close = matchingParen(source, source.indexOf("(", ctor));
  if (close === -1) return injected;
  const params = source.slice(source.indexOf("(", ctor) + 1, close);
  for (const m of params.matchAll(
    /(?:private|public|protected)\s+(?:readonly\s+)?(\w+)\s*:\s*([\w.]+)/g,
  ))
    injected.set(m[1] as string, m[2] as string);
  return injected;
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Balanced-brace body of the handler whose declaration starts at `from`.
 *
 * Brace counting cannot begin until the parameter list has closed: an inline
 * object type in a parameter (`@Body() body: { role: string }`) or in a generic
 * return type (`Promise<{ id: string }>`) opens and closes a brace before the
 * body does, and counting those truncates the handler after its signature. A
 * truncated body has no service calls, which reads downstream as an
 * unauthorized route — a false positive that hides the real ones.
 */
export function handlerBody(
  lines: readonly string[],
  from: number,
): { signature: string; body: string; end: number } {
  const collected: string[] = [];
  let parenDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  let paramsClosed = false;
  let bodyStarted = false;
  let signatureLength = 0;

  for (let i = from; i < lines.length && collected.length <= 400; i++) {
    const line = lines[i] as string;
    const lineStart = collected.join("\n").length + (collected.length > 0 ? 1 : 0);
    collected.push(line);

    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (!paramsClosed) {
        if (ch === "(") parenDepth++;
        else if (ch === ")") {
          parenDepth--;
          if (parenDepth === 0) paramsClosed = true;
        }
        continue;
      }
      if (!bodyStarted) {
        if (ch === "<") angleDepth++;
        else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
        else if (ch === "{" && angleDepth === 0) {
          bodyStarted = true;
          braceDepth = 1;
          signatureLength = lineStart + c;
        }
        continue;
      }
      if (ch === "{") braceDepth++;
      else if (ch === "}") braceDepth--;
    }

    if (bodyStarted && braceDepth <= 0) {
      const body = collected.join("\n");
      return { signature: body.slice(0, signatureLength), body, end: i };
    }
    if (paramsClosed && !bodyStarted && angleDepth === 0 && /;\s*$/.test(line.trim())) break;
  }

  const joined = collected.join("\n");
  return {
    signature: signatureLength > 0 ? joined.slice(0, signatureLength) : joined,
    body: joined,
    end: Math.min(from + collected.length - 1, lines.length - 1),
  };
}

/** `this.<prop>.<method>(<args>)` calls made inside a handler body. */
export function extractServiceCalls(body: string): ServiceCall[] {
  const calls: ServiceCall[] = [];
  const re = /this\.(\w+)\.(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const open = body.indexOf("(", m.index + m[0].length - 1);
    const close = matchingParen(body, open);
    calls.push({
      property: m[1] as string,
      method: m[2] as string,
      args: close === -1 ? "" : body.slice(open + 1, close),
    });
  }
  return calls;
}

interface PendingDecorators {
  isPublic: boolean;
  isUniversal: boolean;
  isInService: boolean;
  hasPermissionDecorator: boolean;
  permissionKeys: string[];
  verb: string | null;
  subPath: string;
}

function emptyPending(): PendingDecorators {
  return {
    isPublic: false,
    isUniversal: false,
    isInService: false,
    hasPermissionDecorator: false,
    permissionKeys: [],
    verb: null,
    subPath: "",
  };
}

function classify(
  handlerDec: PendingDecorators,
  classDec: PendingDecorators,
): Classification {
  if (handlerDec.isPublic) return "public";
  if (handlerDec.isUniversal) return "universal";
  if (handlerDec.hasPermissionDecorator) return "permissioned";
  if (handlerDec.isInService) return "in-service";
  if (classDec.isPublic) return "public";
  if (classDec.isUniversal) return "universal";
  if (classDec.hasPermissionDecorator) return "permissioned";
  if (classDec.isInService) return "in-service";
  return "UNDECLARED";
}

/**
 * Collapses a decorator whose arguments span several lines onto its first line,
 * padding the consumed lines so every index still maps to its original line
 * number. `@AuthorizedInService(` with the reason on the next line is the shape
 * that matters: read line-by-line it looks like an undeclared route.
 */
export function joinMultilineDecorators(lines: readonly string[]): string[] {
  const out = [...lines];
  for (let i = 0; i < out.length; i++) {
    const line = (out[i] as string).trim();
    if (!line.startsWith("@")) continue;
    let depth = 0;
    for (const ch of line) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
    }
    if (depth <= 0) continue;
    let joined = out[i] as string;
    let j = i + 1;
    while (j < out.length && depth > 0) {
      const next = out[j] as string;
      joined += ` ${next.trim()}`;
      for (const ch of next) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      out[j] = "";
      j++;
    }
    out[i] = joined;
  }
  return out;
}

export function parseController(absPath: string, source: string): HandlerRoute[] {
  const rawLines = source.split("\n");
  const lines = joinMultilineDecorators(rawLines);
  const file = relative(BACKEND_ROOT, absPath).replace(/\\/g, "/");
  let injected = new Map<string, string>();

  let controllerClass = "";
  let basePath = "";
  let classDec = emptyPending();
  let pending = emptyPending();
  const routes: HandlerRoute[] = [];
  const constants = new Map<string, string>();
  for (const line of lines) {
    const m = line.match(CONST_KEY_RE);
    if (m) constants.set(m[1] as string, m[2] as string);
  }

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("*") || line.startsWith("/*")) continue;

    if (line.startsWith("@")) {
      const controller = line.match(CONTROLLER_RE);
      if (controller) basePath = controller[1] ?? "";
      if (PUBLIC_RE.test(line)) pending.isPublic = true;
      if (UNIVERSAL_RE.test(line)) pending.isUniversal = true;
      if (IN_SERVICE_RE.test(line)) pending.isInService = true;
      if (PERMISSION_ANY_RE.test(line)) pending.hasPermissionDecorator = true;
      for (const m of line.matchAll(PERMISSION_RE)) pending.permissionKeys.push(m[1] as string);
      const constRef = line.match(PERMISSION_CONST_RE);
      if (constRef) {
        const resolved = constants.get(constRef[1] as string);
        if (resolved) pending.permissionKeys.push(resolved);
      }
      const verb = line.match(VERB_RE);
      if (verb) {
        pending.verb = (verb[1] as string).toUpperCase();
        pending.subPath = verb[2] ?? "";
      }
      continue;
    }

    const klass = line.match(CLASS_RE);
    if (klass) {
      controllerClass = klass[1] as string;
      classDec = pending;
      pending = emptyPending();
      injected = parseInjectedProperties(source, source.indexOf(`class ${controllerClass}`));
      continue;
    }

    if (pending.verb) {
      const method = line.match(METHOD_RE);
      if (method && !KEYWORDS.has(method[1] as string)) {
        const { signature, body, end } = handlerBody(lines, i);
        const path = joinRoutePath(basePath, pending.subPath);
        routes.push({
          file,
          controllerClass,
          handler: method[1] as string,
          verb: pending.verb,
          path,
          pathParams: extractPathParams(path),
          classification: classify(pending, classDec),
          permissionKeys:
            pending.permissionKeys.length > 0 ? pending.permissionKeys : classDec.permissionKeys,
          line: i + 1,
          signature,
          body,
          serviceCalls: extractServiceCalls(body),
          injected,
        });
        pending = emptyPending();
        i = end;
        continue;
      }
    }
    if (!line.startsWith("@")) pending = emptyPending();
  }

  return routes;
}

let cached: HandlerRoute[] | null = null;

export function loadRouteSurface(): HandlerRoute[] {
  if (cached) return cached;
  const routes: HandlerRoute[] = [];
  for (const absPath of walkControllers(SRC_ROOT))
    routes.push(...parseController(absPath, readFileSync(absPath, "utf8")));
  cached = routes;
  return routes;
}

/**
 * Object-addressable = the route names a specific record in its path. These are
 * the routes a BOLA probe can address with another organization's id.
 */
export function isObjectAddressable(route: HandlerRoute): boolean {
  return route.pathParams.length > 0;
}
