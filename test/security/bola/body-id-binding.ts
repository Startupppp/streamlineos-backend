/**
 * Cross-tenant object ids that travel in the REQUEST BODY or the QUERY STRING.
 *
 * The live sweep and every static pass before this one probe the id in the URL
 * PATH. A route that correctly 404s on `/things/:otherOrgThingId` can still
 * accept `{"thingId": <otherOrgThingId>}` and act on it, because the tenant
 * predicate was written for the path parameter and the body field was never
 * resolved at all. `CrmConsentService.record` is the worked example the live
 * sweep stumbled into: it inserts `(org_id = caller's own, contact_id =
 * whatever the body said)` and never reads the contact.
 *
 * WHAT IT DOES
 *
 * 1. Enumerates the surface from `openapi.json` — the committed contract, which
 *    `check:openapi-coverage` holds at 1,371/1,371 mutating request schemas.
 *    Every operation's JSON body properties and `in: query` parameters are read,
 *    and the ones whose NAME is id-shaped are kept.
 * 2. Joins each operation to its handler through `operationId`, which Nest emits
 *    as `<ControllerClass>_<handler>`, using the same controller parser the rest
 *    of this directory uses.
 * 3. Follows the field from the handler into the services it calls, and asks a
 *    PER-FIELD question — not the per-route question `tenant-binding.ts` asks.
 *    A route earns `org-predicate` there as soon as ANY read in it binds a
 *    tenant, which is exactly how a body id gets missed: the path parameter's
 *    predicate answers for the whole handler.
 *
 * WHY THE VERDICTS ARE SHAPED THIS WAY
 *
 * `written-unresolved` is the finding that matters. It means every use of the
 * id is inside an `insert().values({…})` or an `update().set({…})` — the id is
 * stored as a reference without ever being read back under the caller's org, so
 * the row that lands points at an object the caller may not own.
 *
 * A call site that hands the id to another service ALONGSIDE `orgId` is NOT
 * counted as bound. That is delegation, not authorization, and treating it as
 * proof is how a coarse detector reads a broken callee as safe. The trace
 * follows the argument into the callee by POSITION and asks the same question
 * of the callee's own parameter name.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKEND_ROOT, loadRouteSurface, type HandlerRoute } from "./route-surface";
import { buildSourceIndex, resolveInjectedType, type SourceIndex, type SourceMethod } from "./tenant-binding";

export type FieldLocation = "body" | "query";

export interface IdFieldSite {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly location: FieldLocation;
  readonly field: string;
}

export type FieldVerdict =
  | "org-predicate"
  | "object-assertion"
  | "filter-in-org-query"
  | "path-parameter"
  | "written-unresolved"
  | "unresolved"
  | "never-read"
  | "handler-not-found";

export interface FieldBinding extends IdFieldSite {
  readonly verdict: FieldVerdict;
  readonly evidence: string;
  readonly where: string;
  /** For a `written-unresolved` field: the Drizzle table the row lands in. */
  readonly writeTable?: string;
}

/**
 * The tenant selector and the actor selector are not object references, they are
 * the two things CLAUDE.md §5 says a client may never send about itself. They
 * are counted separately rather than folded into the id analysis, because the
 * question about them is "why is this accepted at all", not "is it resolved".
 */
export const TENANT_SELECTOR_FIELDS = new Set(["orgId", "organizationId", "tenantId", "org_id"]);
export const ACTOR_SELECTOR_FIELDS = new Set([
  "userId",
  "actorId",
  "createdById",
  "authorId",
  "currentUserId",
  "requesterId",
]);

const ID_NAME_RE = /(?:^|[a-z0-9])(Id|Ids)$/;

// A tenant or actor id is a UUID string; a numeric one is an ordinary FK sharing the name.
function declaresNumericId(schema: unknown): boolean {
  if (typeof schema !== "object" || schema === null) return false;
  const node = schema as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (node.type === "number" || node.type === "integer") return true;
  for (const branch of [node.anyOf, node.oneOf])
    if (Array.isArray(branch) && branch.some((option) => declaresNumericId(option)))
      return true;
  return false;
}

interface OpenApiOperation {
  operationId?: string;
  parameters?: { name?: string; in?: string; schema?: unknown }[];
  requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> };
}

export function readContract(): Record<string, Record<string, OpenApiOperation>> {
  const raw: unknown = JSON.parse(readFileSync(join(BACKEND_ROOT, "openapi.json"), "utf8"));
  const paths: unknown = (raw as { paths?: unknown }).paths;
  return (paths ?? {}) as Record<string, Record<string, OpenApiOperation>>;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export interface SurfaceCounts {
  readonly operations: number;
  readonly idFields: number;
  readonly bodyFields: number;
  readonly queryFields: number;
  readonly operationsWithIdFields: number;
  readonly tenantSelectors: IdFieldSite[];
  readonly actorSelectors: IdFieldSite[];
}

/** Every id-shaped body property and query parameter in the committed contract. */
export function enumerateIdFieldSites(): { sites: IdFieldSite[]; counts: SurfaceCounts } {
  const paths = readContract();
  const sites: IdFieldSite[] = [];
  const tenantSelectors: IdFieldSite[] = [];
  const actorSelectors: IdFieldSite[] = [];
  const withFields = new Set<string>();
  let operations = 0;

  for (const [path, item] of Object.entries(paths)) {
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method)) continue;
      operations += 1;
      const operationId = operation.operationId ?? "";
      const named: { location: FieldLocation; field: string; declared: unknown }[] = [];

      const schema = operation.requestBody?.content?.["application/json"]?.schema;
      for (const [property, declared] of Object.entries(schema?.properties ?? {}))
        named.push({ location: "body", field: property, declared });
      for (const parameter of operation.parameters ?? [])
        if (parameter.in === "query" && parameter.name)
          named.push({ location: "query", field: parameter.name, declared: parameter.schema });

      for (const { location, field, declared } of named) {
        if (!ID_NAME_RE.test(field)) continue;
        const site: IdFieldSite = { operationId, method: method.toUpperCase(), path, location, field };
        const selectorShaped = !declaresNumericId(declared);
        if (selectorShaped && TENANT_SELECTOR_FIELDS.has(field)) tenantSelectors.push(site);
        else if (selectorShaped && ACTOR_SELECTOR_FIELDS.has(field)) actorSelectors.push(site);
        else {
          sites.push(site);
          withFields.add(operationId);
        }
      }
    }
  }

  return {
    sites,
    counts: {
      operations,
      idFields: sites.length,
      bodyFields: sites.filter((s) => s.location === "body").length,
      queryFields: sites.filter((s) => s.location === "query").length,
      operationsWithIdFields: withFields.size,
      tenantSelectors,
      actorSelectors,
    },
  };
}

// --- source tracing ----------------------------------------------------------

const ORG_TOKEN_RE = /\b(?:orgId|organizationId|current_org_id|currentOrgId)\b/;

/**
 * Helpers whose whole job is to re-assert the caller's access to one object.
 * Narrower than `tenant-binding.ts`'s list on purpose: this file asks about ONE
 * field, so a generic `assertAccess()` elsewhere in the method is not evidence
 * about this field.
 */
const ASSERTION_CALL_RE =
  /\b(?:mustGet\w*|assert\w*|ensure\w*|require\w*|resolveScoped\w*|loadScoped\w*)\s*\($/;

/** `this.x.y(` / `this.y(` immediately before a group — a delegation boundary. */
const DELEGATION_HEAD_RE = /this\.(\w+)(?:\.(\w+))?\s*\($/;

/**
 * A bare `someFunction(` call head — a delegation into a FREE function.
 *
 * MEASURED, and it is a blind spot the file-size programme opens repeatedly. `c7e4628a` moved
 * `ActivitiesService.timeline`'s query into an exported `queryTimeline(db, organizationId, query)`
 * in a new module; the method now reads `return queryTimeline(this.db, organizationId, query);` and
 * nothing about the field is visible in it any more. Three query id sites on
 * `ActivitiesController_timeline` — `partyId`, `dealId`, `subjectId` — went `filter-in-org-query`
 * -> `never-read` on that commit alone, which reads as "the surface shrank" when what shrank was
 * the analyser's reach.
 *
 * Unlike `this.` delegation this does NOT stop the scan of enclosing groups: `eq(`, `and(` and
 * `push(` are call heads too, and breaking on them would lose the `org-predicate` evidence that
 * sits one group further out. Free calls are collected and followed only after every other rule
 * has had its say, and only when the name resolves to a function declared in `src/`.
 */
const FREE_CALL_HEAD_RE = /(?:^|[^.\w$])([a-z][A-Za-z0-9_$]*)\s*\($/;

/**
 * A predicate position: the id is being used to SELECT rows, not to store a
 * reference. A foreign id in a predicate that sits in an org-bound query simply
 * matches nothing, which is why `filter-in-org-query` is a pass rather than a
 * finding.
 */
const PREDICATE_HEAD_RE = /\b(?:eq|ne|inArray|notInArray|gt|gte|lt|lte|like|ilike|arrayContains|where|and|or|push)\s*\($/;

interface Occurrence {
  readonly index: number;
  readonly inWriteLiteral: boolean;
  readonly inPredicate: boolean;
}

/** Balanced `(` groups enclosing `index`, innermost first, capped at `limit`. */
function enclosingGroups(source: string, index: number, limit: number): { head: string; open: number; text: string }[] {
  const groups: { head: string; open: number; text: string }[] = [];
  let cursor = index;
  for (let level = 0; level < limit; level++) {
    let depth = 0;
    let open = -1;
    for (let i = cursor - 1; i >= 0; i--) {
      const ch = source[i];
      if (ch === ")") depth += 1;
      else if (ch === "(") {
        if (depth === 0) {
          open = i;
          break;
        }
        depth -= 1;
      }
    }
    if (open === -1) break;
    let close = -1;
    let inner = 0;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (ch === "(") inner += 1;
      else if (ch === ")") {
        inner -= 1;
        if (inner === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) break;
    groups.push({
      head: source.slice(Math.max(0, open - 80), open + 1),
      open,
      text: source.slice(open, close + 1),
    });
    cursor = open;
  }
  return groups;
}

const WRITE_LITERAL_HEAD_RE = /\.(?:values|set)\s*\(\s*(?:\.\.\.[\w.]+\s*,\s*)?$/;

/**
 * True when the occurrence sits inside the object literal handed to
 * `insert().values({…})` or `update().set({…})`.
 *
 * This is the rule the whole detector turns on. A write literal routinely
 * carries `orgId` beside the foreign id — `.values({ orgId, contactId })` is the
 * CrmConsent bug verbatim — so a group-level org-token test would read the
 * defect as bound. An occurrence in a write literal is therefore NEVER counted
 * as authorization, no matter what else is in the literal.
 */
function writeLiteralAt(source: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0 && index - i < 3000; i--) {
    const ch = source[i];
    if (ch === "}") depth += 1;
    else if (ch === "{") {
      if (depth === 0) return WRITE_LITERAL_HEAD_RE.test(source.slice(Math.max(0, i - 60), i));
      depth -= 1;
    }
  }
  return false;
}

interface Symbolic {
  readonly object: string | null;
  readonly field: string;
}

function occurrenceRegExp(symbol: Symbolic): RegExp {
  const field = escapeRe(symbol.field);
  if (symbol.object === null) return new RegExp(`(?<![\\w$.])${field}(?![\\w$])`, "g");
  const object = escapeRe(symbol.object);
  return new RegExp(`(?<![\\w$.])${object}\\s*(?:\\?\\.|\\.)\\s*${field}(?![\\w$])`, "g");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findOccurrences(body: string, symbol: Symbolic): Occurrence[] {
  const out: Occurrence[] = [];
  const re = occurrenceRegExp(symbol);
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const at = m.index + m[0].length - symbol.field.length;
    const groups = enclosingGroups(body, at, 2);
    out.push({
      index: at,
      inWriteLiteral: writeLiteralAt(body, at),
      inPredicate: groups.some((g) => PREDICATE_HEAD_RE.test(g.head)),
    });
  }
  return out;
}

/** `const { field } = object` / `const { field: alias } = object`. */
function destructuredName(body: string, symbol: Symbolic): string | null {
  if (symbol.object === null) return null;
  const re = new RegExp(`(?:const|let)\\s*\\{([^}]*)\\}\\s*=\\s*${escapeRe(symbol.object)}(?![\\w$])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    for (const part of (m[1] as string).split(",")) {
      const named = /^\s*([\w$]+)\s*(?::\s*([\w$]+))?/.exec(part);
      if (named && named[1] === symbol.field) return named[2] ?? named[1];
    }
  }
  return null;
}

/** `.values({ ...object })` — the field lands in the row without ever being named. */
function spreadIntoWrite(body: string, symbol: Symbolic): string | null {
  if (symbol.object === null) return null;
  const re = new RegExp(`\\.\\.\\.\\s*${escapeRe(symbol.object)}(?![\\w$])`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null)
    if (writeLiteralAt(body, m.index + 3)) return writeTargetAt(body, m.index) ?? "unknown";
  return null;
}

/** Which argument slot `index` falls into, for the call whose `(` is at `open`. */
function argumentSlot(source: string, open: number, index: number): number {
  let slot = 0;
  let depth = 0;
  for (let i = open + 1; i < index; i++) {
    const ch = source[i];
    if ("({[".includes(ch)) depth += 1;
    else if (")}]".includes(ch)) depth -= 1;
    else if (ch === "," && depth === 0) slot += 1;
  }
  return slot;
}

/** Parameter names of a method signature, in order. */
export function parameterNames(signature: string): string[] {
  const open = signature.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  let close = -1;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) return [];
  const parts: string[] = [];
  let current = "";
  let nesting = 0;
  for (const ch of signature.slice(open + 1, close)) {
    if ("({[<".includes(ch)) nesting += 1;
    if (")}]>".includes(ch)) nesting -= 1;
    if (ch === "," && nesting === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => {
    const stripped = part.replace(/@\w+\s*\([^)]*\)/g, "").replace(/@\w+/g, "").trim();
    const name = /^(?:readonly\s+)?(?:private\s+|public\s+|protected\s+)?([\w$]+)/.exec(stripped);
    return name ? (name[1] as string) : "";
  });
}

interface TraceResult {
  readonly verdict: FieldVerdict;
  readonly evidence: string;
  readonly where: string;
  readonly writeTable?: string;
}

/**
 * The Drizzle table symbol of the `insert(x)` / `update(x)` whose literal
 * encloses `index`. It is what turns a source finding into a schema question:
 * a column carrying a COMPOSITE tenant FK cannot hold another organisation's
 * id, so the same source shape is a live defect on one table and a caught
 * error on another.
 */
function writeTargetAt(source: string, index: number): string | null {
  const before = source.slice(Math.max(0, index - 3000), index);
  const call = /\.(?:insert|update)\s*\(\s*([\w$]+)\s*\)/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = call.exec(before)) !== null) last = m[1] as string;
  return last;
}

const MAX_DEPTH = 4;

function lookupMethod(index: SourceIndex, owner: string, name: string): SourceMethod | undefined {
  return index.methodsByClass.get(owner)?.get(name) ?? index.functions.get(name);
}

/**
 * Calls in `body` that forward `carrier` WHOLE — `queryTimeline(this.db, orgId, query)`.
 *
 * `traceFromHandler` already does this at the controller boundary, where the DTO is normally passed
 * on entire and the field name never appears. The same thing happens one level down and had no
 * equivalent: after `c7e4628a` extracted `ActivitiesService.timeline`'s query into a free
 * `queryTimeline(...)`, the method body reads `return queryTimeline(this.db, organizationId,
 * query);` — `query.partyId` occurs nowhere in it, so the trace ended at `never-read` with the org
 * predicate sitting one file away. Three sites moved on that commit alone.
 */
function forwardedCalls(body: string, carrier: string): { head: string; slot: number }[] {
  const out: { head: string; slot: number }[] = [];
  const call = /(?:(this\.\w+(?:\.\w+)?)|(?:^|[^.\w$])([a-z][A-Za-z0-9_$]*))\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(body)) !== null) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < body.length; i++) {
      if (body[i] === "(") depth += 1;
      else if (body[i] === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) continue;
    const slot = carrierSlot(body.slice(open + 1, close), carrier);
    if (slot === -1) continue;
    out.push({ head: (match[1] ?? match[2]) as string, slot });
  }
  return out;
}

function traceSymbol(
  owner: string,
  method: SourceMethod,
  symbol: Symbolic,
  index: SourceIndex,
  depth: number,
  seen: Set<string>,
): TraceResult {
  const label = symbol.object === null ? symbol.field : `${symbol.object}.${symbol.field}`;
  const key = `${owner}.${method.name}#${label}`;
  const at = `${key} (${method.file})`;
  if (seen.has(key) || depth > MAX_DEPTH) return { verdict: "unresolved", evidence: "trace depth", where: at };
  seen.add(key);

  const body = method.body.slice(method.signature.length);
  const occurrences = findOccurrences(body, symbol);
  const delegations: { property: string; callee: string | null; slot: number }[] = [];
  const freeCalls: { name: string; slot: number }[] = [];
  let sawWrite = false;
  let sawNonWrite = false;
  let sawPredicate = false;
  let writeTable: string | null = null;

  for (const occurrence of occurrences) {
    if (occurrence.inWriteLiteral) {
      sawWrite = true;
      writeTable = writeTable ?? writeTargetAt(body, occurrence.index);
      continue;
    }
    sawNonWrite = true;
    if (occurrence.inPredicate) sawPredicate = true;
    for (const group of enclosingGroups(body, occurrence.index, 4)) {
      const head = DELEGATION_HEAD_RE.exec(group.head);
      if (head) {
        delegations.push({
          property: head[1] as string,
          callee: head[2] ?? null,
          slot: argumentSlot(body, group.open, occurrence.index),
        });
        break;
      }
      if (ASSERTION_CALL_RE.test(group.head))
        return { verdict: "object-assertion", evidence: group.head.trim().slice(-60), where: at };
      if (ORG_TOKEN_RE.test(group.text))
        return { verdict: "org-predicate", evidence: group.text.replace(/\s+/g, " ").slice(0, 140), where: at };
      const free = FREE_CALL_HEAD_RE.exec(group.head);
      if (free)
        freeCalls.push({ name: free[1] as string, slot: argumentSlot(body, group.open, occurrence.index) });
    }
  }

  for (const delegation of delegations) {
    const calleeClass = delegation.callee ? resolveInjectedType(method.file, delegation.property) : owner;
    const calleeName = delegation.callee ?? delegation.property;
    if (!calleeClass) continue;
    const callee = lookupMethod(index, calleeClass, calleeName);
    if (!callee) continue;
    const next = parameterNames(callee.signature)[delegation.slot];
    if (!next) continue;
    const nested = traceSymbol(calleeClass, callee, { object: null, field: next }, index, depth + 1, seen);
    if (nested.verdict === "org-predicate" || nested.verdict === "object-assertion") return nested;
  }

  for (const call of freeCalls) {
    const callee = index.functions.get(call.name);
    if (!callee) continue;
    const next = parameterNames(callee.signature)[call.slot];
    if (!next) continue;
    const nested = traceSymbol(callee.owner, callee, { object: null, field: next }, index, depth + 1, seen);
    if (nested.verdict !== "never-read" && nested.verdict !== "unresolved") return nested;
  }

  /**
   * The object was forwarded whole and the field never named — follow the carrier one level down.
   * Only when nothing about the field was visible here, so it can never override closer evidence.
   */
  if (occurrences.length === 0 && symbol.object !== null)
    for (const forward of forwardedCalls(body, symbol.object)) {
      const viaThis = /^this\.(\w+)(?:\.(\w+))?$/.exec(forward.head);
      const calleeClass = viaThis
        ? (viaThis[2] ? resolveInjectedType(method.file, viaThis[1] as string) : owner)
        : owner;
      const calleeName = viaThis ? ((viaThis[2] ?? viaThis[1]) as string) : forward.head;
      if (!calleeClass) continue;
      const callee = lookupMethod(index, calleeClass, calleeName);
      if (!callee) continue;
      const next = parameterNames(callee.signature)[forward.slot];
      if (!next) continue;
      const nested = traceSymbol(callee.owner, callee, { object: next, field: symbol.field }, index, depth + 1, seen);
      if (nested.verdict !== "never-read" && nested.verdict !== "unresolved") return nested;
    }

  const local = destructuredName(body, symbol);
  if (local) {
    const nested = traceSymbol(owner, method, { object: null, field: local }, index, depth + 1, seen);
    if (nested.verdict !== "never-read") return nested;
  }

  if (sawPredicate && ORG_TOKEN_RE.test(body))
    return {
      verdict: "filter-in-org-query",
      evidence: "used only as a predicate in a method that binds orgId",
      where: at,
    };
  if (sawWrite && !sawNonWrite)
    return {
      verdict: "written-unresolved",
      evidence: "every use is inside insert().values()/update().set()",
      where: at,
      writeTable: writeTable ?? undefined,
    };
  const spread = spreadIntoWrite(body, symbol);
  if (spread)
    return {
      verdict: "written-unresolved",
      evidence: `spread into a write literal as ...${symbol.object ?? ""}`,
      where: at,
      writeTable: spread,
    };
  if (occurrences.length > 0) return { verdict: "unresolved", evidence: "", where: at };
  return { verdict: "never-read", evidence: "", where: at };
}

/**
 * Enters at the handler. The DTO object is normally forwarded whole
 * (`this.svc.create(u.orgId, body)`), so the field name never appears in the
 * controller — the trace carries the OBJECT into the callee first and only then
 * looks for `<object>.<field>`.
 */
function traceFromHandler(route: HandlerRoute, field: string, index: SourceIndex): TraceResult {
  const synthetic: SourceMethod = {
    owner: route.controllerClass,
    file: route.file,
    name: route.handler,
    signature: route.signature,
    body: route.body,
  };

  const inline = traceSymbol(route.controllerClass, synthetic, { object: null, field }, index, 0, new Set());
  if (inline.verdict !== "never-read") return inline;

  const carriers = parameterNames(route.signature).filter((name) => name && !/^(?:req|request|res|response)$/.test(name));
  let best: TraceResult = { verdict: "never-read", evidence: "", where: `${route.controllerClass}.${route.handler}` };

  for (const carrier of carriers) {
    for (const call of route.serviceCalls) {
      const slot = carrierSlot(call.args, carrier);
      if (slot === -1) continue;
      const calleeClass = route.injected.get(call.property);
      if (!calleeClass) continue;
      const callee = lookupMethod(index, calleeClass, call.method);
      if (!callee) continue;
      const objectSymbol = parameterNames(callee.signature)[slot];
      if (!objectSymbol) continue;
      const result = traceSymbol(calleeClass, callee, { object: objectSymbol, field }, index, 1, new Set());
      if (result.verdict === "org-predicate" || result.verdict === "object-assertion" || result.verdict === "filter-in-org-query")
        return result;
      if (result.verdict !== "never-read") best = result;
    }
  }
  return best;
}

/** The argument slot in `args` that is exactly `carrier` (or spreads it). */
function carrierSlot(args: string, carrier: string): number {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  for (const ch of args) {
    if ("({[".includes(ch)) depth += 1;
    if (")}]".includes(ch)) depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  for (let slot = 0; slot < parts.length; slot++)
    if (new RegExp(`^\\s*(?:\\.\\.\\.)?${escapeRe(carrier)}\\s*$`).test(parts[slot] as string)) return slot;
  return -1;
}

/**
 * Nest appends `_v<n>` to the operationId of a handler carrying `@Version`, so
 * `UsersController.listUsersV2` on `API_VERSION_NEXT` is emitted as
 * `UsersController_listUsersV2_v2`. A direct lookup misses it, and a miss is
 * recorded as `handler-not-found` — a blind spot, not a pass, which is how four
 * id-shaped query fields on `GET /v2/users` went unanalysed. Resolve the
 * unsuffixed form on a miss so every versioned route is swept; a genuinely
 * absent handler still misses both ways and stays visible.
 */
function resolveRoute(
  byOperationId: ReadonlyMap<string, HandlerRoute>,
  operationId: string,
): HandlerRoute | undefined {
  const direct = byOperationId.get(operationId);
  if (direct) return direct;
  const unversioned = operationId.replace(/_v\d+$/, "");
  return unversioned === operationId ? undefined : byOperationId.get(unversioned);
}

export function analyzeIdFields(): FieldBinding[] {
  const { sites } = enumerateIdFieldSites();
  const routes = loadRouteSurface();
  const index = buildSourceIndex();
  const byOperationId = new Map<string, HandlerRoute>();
  for (const route of routes) byOperationId.set(`${route.controllerClass}_${route.handler}`, route);

  return sites.map((site): FieldBinding => {
    const route = resolveRoute(byOperationId, site.operationId);
    if (!route) return { ...site, verdict: "handler-not-found", evidence: "", where: "" };
    if (route.pathParams.includes(site.field))
      return { ...site, verdict: "path-parameter", evidence: "also a path parameter", where: route.file };
    return { ...site, ...traceFromHandler(route, site.field, index) };
  });
}

export const FINDING_VERDICTS: readonly FieldVerdict[] = ["written-unresolved", "unresolved"];

export function summarize(bindings: readonly FieldBinding[]): Record<FieldVerdict, number> {
  const counts: Record<FieldVerdict, number> = {
    "org-predicate": 0,
    "object-assertion": 0,
    "filter-in-org-query": 0,
    "path-parameter": 0,
    "written-unresolved": 0,
    unresolved: 0,
    "never-read": 0,
    "handler-not-found": 0,
  };
  for (const binding of bindings) counts[binding.verdict] += 1;
  return counts;
}

/**
 * Test seam. Classifies one field inside a snippet of service source with no
 * source index behind it, so the detector's own rules can be exercised against
 * fixtures rather than only against the repository.
 */
export function classifyFieldInSource(source: string, object: string | null, field: string): FieldVerdict {
  const signature = source.slice(0, source.indexOf("{") + 1);
  const method: SourceMethod = { owner: "Fixture", file: "fixture.ts", name: "fixture", signature, body: source };
  const empty: SourceIndex = { methodsByClass: new Map(), functions: new Map() };
  return traceSymbol("Fixture", method, { object, field }, empty, 0, new Set()).verdict;
}
