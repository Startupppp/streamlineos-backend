import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A minimal valid request, synthesised from the committed OpenAPI contract.
 *
 * WHY THIS EXISTS
 *
 * The live cross-tenant sweep sent `{}` as the body of every POST/PUT/PATCH. A `.strict()` Zod
 * object with any required field rejects that, so the OWN-TENANT CONTROL answered 400 and
 * `score()` — correctly — refused to grade the route. 468 routes were filed UNPROBEABLE for that
 * reason alone: 41% of the unprobeable set and 24% of the whole object-addressable surface. They
 * were never asked the question the ticket is about.
 *
 * The input needed already exists and is gated: `pnpm check:openapi-coverage` is exit 0 with
 * 1,371/1,371 mutating operations carrying a request body schema, so a body that satisfies the
 * boundary can be derived per route rather than hand-written 468 times.
 *
 * WHAT "MINIMAL" MEANS, AND WHY IT MATTERS
 *
 * Only `required` properties are populated, and each gets the smallest value its own constraints
 * admit. A fatter body would fail more often, not less: every extra field is another `.strict()`
 * key to get wrong, another enum to miss, another foreign key to dangle.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not guess. A schema whose constraints it cannot satisfy — an unrecognised `pattern`, a
 * `oneOf` with no viable branch — returns the reason in `unsatisfiable` and NO body, so the route
 * stays UNPROBEABLE with an honest explanation instead of being sent a body that will 400 and be
 * recorded as though the route had been asked. A cross-domain refinement Zod expresses with
 * `superRefine` does not reach JSON Schema at all, so some routes will still answer 400; that is a
 * measured residue, not a silent one.
 *
 * Required QUERY parameters are synthesised the same way. 50 of the 468 are GET or DELETE routes
 * whose control 400s on a missing `from`/`to` rather than on a body, and the register's "sends no
 * request body" is only two thirds of the story.
 */

interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly pattern?: string;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly items?: JsonSchema;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly multipleOf?: number;
  readonly allOf?: readonly JsonSchema[];
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly nullable?: boolean;
  readonly additionalProperties?: boolean | JsonSchema;
}

interface OperationParameter {
  readonly name: string;
  readonly in: string;
  readonly required?: boolean;
  readonly schema?: JsonSchema;
}

interface Operation {
  readonly parameters?: readonly OperationParameter[];
  readonly requestBody?: {
    readonly required?: boolean;
    readonly content?: Readonly<Record<string, { readonly schema?: JsonSchema }>>;
  };
}

interface OpenApiDocument {
  readonly paths: Readonly<Record<string, Readonly<Record<string, Operation>>>>;
  readonly components?: { readonly schemas?: Readonly<Record<string, JsonSchema>> };
}

const OPENAPI_PATH = join(__dirname, "..", "..", "..", "..", "openapi.json");

let documentCache: OpenApiDocument | null = null;

export function loadOpenApiDocument(): OpenApiDocument {
  if (documentCache) return documentCache;
  documentCache = JSON.parse(readFileSync(OPENAPI_PATH, "utf8")) as OpenApiDocument;
  return documentCache;
}

/** `/build/:projectId/bugs/:bugId` is the harness's shape; the contract writes `{projectId}`. */
export function toContractPath(routePath: string): string {
  return routePath.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

export function findOperation(verb: string, routePath: string): Operation | null {
  const doc = loadOpenApiDocument();
  return doc.paths[toContractPath(routePath)]?.[verb.toLowerCase()] ?? null;
}

/**
 * What the contract says a path parameter IS — the cheapest way to rule a candidate table out.
 *
 * Measured over `openapi.json`: 1,685 of the 2,245 declared path parameters are `integer`/`number`
 * and 44 are `format: uuid`. A table whose primary key is the other kind cannot serve them: the
 * request never reaches the handler, it dies in the validation interceptor with "Invalid UUID" or
 * "expected number, received NaN", and the route is filed unprobeable for a reason that is entirely
 * the harness's. The remaining `string` parameters are left unfiltered because `z.string().min(1)`
 * accepts a numeric key as readily as a uuid.
 */
export type PathParamShape = "integer" | "uuid" | "unconstrained";

export function pathParamShape(verb: string, routePath: string, param: string): PathParamShape {
  const operation = findOperation(verb, routePath);
  const declared = (operation?.parameters ?? []).find((entry) => entry.in === "path" && entry.name === param);
  const schema = declared?.schema;
  if (!schema) return "unconstrained";
  if (schema.type === "integer" || schema.type === "number") return "integer";
  if (schema.format === "uuid") return "uuid";
  return "unconstrained";
}

type Attempt = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly why: string };

const ok = (value: unknown): Attempt => ({ ok: true, value });
const no = (why: string): Attempt => ({ ok: false, why });

function deref(schema: JsonSchema, seen: ReadonlySet<string>): Attempt {
  const ref = schema.$ref;
  if (ref === undefined) return ok(schema);
  const name = ref.replace("#/components/schemas/", "");
  if (seen.has(name)) return no(`recursive $ref ${name}`);
  const target = loadOpenApiDocument().components?.schemas?.[name];
  if (!target) return no(`unresolved $ref ${ref}`);
  return ok(target);
}

/**
 * String candidates are tried against `pattern` in order and the first match wins.
 *
 * Solving an arbitrary regex is not worth writing; recognising the handful this contract actually
 * uses is. The date-time pattern here is the leap-year-aware one Zod emits, which no naive
 * generator satisfies, so the candidate has to be a real ISO instant.
 */
function stringCandidates(schema: JsonSchema, nonce: string): string[] {
  const out: string[] = [];
  const push = (value: string): void => {
    if (!out.includes(value)) out.push(value);
  };
  const format = schema.format ?? "";
  /**
   * A CONSTANT body collides with a unique index, and that corrupts the three-way control.
   *
   * Measured: `POST /build/:projectId/labels` under `uniq_ticket_labels_org_name (org_id, name)`.
   * The cross-tenant probe created "bola-probe" in the prober's org and answered 201, the
   * own-tenant control created it in the source org and answered 201, and the absent-id request —
   * sent as the prober again, into the org that now holds that name — raised 23505 and answered
   * 500. `disambiguate` compares the cross-tenant answer with the absent one, saw 201 against 500,
   * and could not demote the verdict, so a route that discloses nothing was scored LEAK.
   *
   * A per-request nonce makes the three bodies equivalent-but-distinct, which is what makes the
   * three answers comparable at all. It is applied only where the schema constrains nothing — an
   * enum, a const, a format or a pattern still wins, so a patterned unique column remains a known
   * residual rather than a silently wrong verdict.
   */
  if (nonce.length > 0 && schema.enum === undefined && schema.const === undefined && schema.pattern === undefined) {
    if (format === "email") push(`bola.${nonce}@example.com`);
    else if (format === "") push(`bola-${nonce}`);
  }
  if (format === "uuid") push("00000000-0000-4000-8000-000000000000");
  if (format === "date-time") push("2027-01-15T00:00:00.000Z");
  if (format === "date") push("2027-01-15");
  if (format === "email") push("bola.probe@example.com");
  if (format === "uri" || format === "url") push("https://example.com/bola-probe");
  push("bola-probe");
  push("2027-01-15");
  push("2027-01-15T00:00:00.000Z");
  push("00000000-0000-4000-8000-000000000000");
  push("bola.probe@example.com");
  push("https://example.com/bola-probe");
  push("1");
  push("+10000000000");
  push("BOLA_PROBE");
  push("Bola Probe");
  push("BOLA01");
  push("2027-01");
  push("123456");
  push("1.0");
  push("#101010");
  push("bola");
  push("1");
  push("a");
  return out;
}

/**
 * `\p{L}` is inert without the `u` flag — the class then matches a literal "p", so a name pattern
 * that accepts every letter rejects every candidate. Unicode mode is tried first and only falls
 * back when the pattern is not valid under it.
 */
function compilePattern(pattern: string): RegExp | null {
  try {
    return new RegExp(pattern, "u");
  } catch {
    try {
      return new RegExp(pattern);
    } catch {
      return null;
    }
  }
}

function fitLength(value: string, schema: JsonSchema): string | null {
  const min = schema.minLength ?? 0;
  const max = schema.maxLength ?? Number.MAX_SAFE_INTEGER;
  if (max < min) return null;
  let out = value;
  while (out.length < min) out += "x";
  if (out.length > max) out = out.slice(0, max);
  return out.length >= min ? out : null;
}

function synthesizeString(schema: JsonSchema, where: string, nonce: string): Attempt {
  const regex = schema.pattern === undefined ? null : compilePattern(schema.pattern);
  if (schema.pattern !== undefined && regex === null) return no(`${where}: pattern ${schema.pattern} does not compile`);
  for (const candidate of stringCandidates(schema, nonce)) {
    const fitted = fitLength(candidate, schema);
    if (fitted === null) continue;
    if (regex && !regex.test(fitted)) continue;
    return ok(fitted);
  }
  return no(`${where}: no candidate satisfies pattern ${String(schema.pattern)}`);
}

function synthesizeNumber(schema: JsonSchema, integral: boolean, where: string): Attempt {
  const lowerExclusive = schema.exclusiveMinimum;
  let value = schema.minimum ?? (lowerExclusive === undefined ? (integral ? 1 : 1) : lowerExclusive + 1);
  if (lowerExclusive !== undefined && value <= lowerExclusive) value = lowerExclusive + 1;
  const step = schema.multipleOf;
  if (step !== undefined && step > 0) value = Math.ceil(value / step) * step;
  const upper = schema.maximum ?? schema.exclusiveMaximum;
  if (upper !== undefined && value > upper) return no(`${where}: no value inside [${String(value)}, ${String(upper)}]`);
  if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
    return no(`${where}: no value below exclusiveMaximum ${String(schema.exclusiveMaximum)}`);
  return ok(integral ? Math.trunc(value) : value);
}

function isUnconstrained(schema: JsonSchema): boolean {
  return (
    schema.type === undefined &&
    schema.properties === undefined &&
    schema.items === undefined &&
    schema.enum === undefined &&
    schema.allOf === undefined &&
    schema.oneOf === undefined &&
    schema.anyOf === undefined &&
    schema.$ref === undefined
  );
}

/** The declared type, with "null" discarded — a nullable field still gets a real value. */
function concreteType(schema: JsonSchema): string | null {
  const declared = schema.type;
  if (typeof declared === "string") return declared === "null" ? null : declared;
  if (Array.isArray(declared)) return declared.find((t) => t !== "null") ?? null;
  return null;
}

function synthesizeValue(raw: JsonSchema, where: string, seen: ReadonlySet<string>, nonce = ""): Attempt {
  const resolved = deref(raw, seen);
  if (!resolved.ok) return resolved;
  const schema = resolved.value as JsonSchema;
  const nextSeen = raw.$ref === undefined ? seen : new Set([...seen, raw.$ref.replace("#/components/schemas/", "")]);

  if (schema.const !== undefined) return ok(schema.const);
  if (schema.enum && schema.enum.length > 0) return ok(schema.enum[0]);

  if (schema.allOf && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const branch of schema.allOf) {
      const part = synthesizeValue(branch, where, nextSeen, nonce);
      if (!part.ok) return part;
      if (part.value !== null && typeof part.value === "object" && !Array.isArray(part.value))
        Object.assign(merged, part.value);
    }
    return ok(merged);
  }

  const union = schema.oneOf ?? schema.anyOf;
  if (union && union.length > 0) {
    const reasons: string[] = [];
    for (const branch of union) {
      const attempt = synthesizeValue(branch, where, nextSeen, nonce);
      if (attempt.ok) return attempt;
      reasons.push(attempt.why);
    }
    return no(`${where}: no union branch is satisfiable (${reasons.slice(0, 2).join("; ")})`);
  }

  const type = concreteType(schema) ?? (schema.properties ? "object" : schema.items ? "array" : null);

  if (type === "object") {
    const out: Record<string, unknown> = {};
    for (const name of schema.required ?? []) {
      const property = schema.properties?.[name];
      if (!property) return no(`${where}.${name}: required but has no schema`);
      const attempt = synthesizeValue(property, `${where}.${name}`, nextSeen, nonce);
      if (!attempt.ok) return attempt;
      out[name] = attempt.value;
    }
    return ok(out);
  }

  if (type === "array") {
    const count = schema.minItems ?? 0;
    if (count === 0) return ok([]);
    if (!schema.items) return no(`${where}: minItems ${String(count)} but no item schema`);
    const item = synthesizeValue(schema.items, `${where}[]`, nextSeen, nonce);
    if (!item.ok) return item;
    return ok(Array.from({ length: count }, () => item.value));
  }

  if (type === "string") return synthesizeString(schema, where, nonce);
  if (type === "integer") return synthesizeNumber(schema, true, where);
  if (type === "number") return synthesizeNumber(schema, false, where);
  if (type === "boolean") return ok(true);
  if (type === null && schema.nullable === true) return ok(null);
  /**
   * An empty schema is JSON Schema's "anything", which `null` satisfies. It is what a `z.unknown()`
   * or a coerced date reaches the contract as. Emitting null is reading the contract literally, not
   * guessing — and any 400 that still follows is a Zod refinement the contract never expressed,
   * which the sweep records as a measured residue rather than a silent one.
   */
  if (isUnconstrained(schema)) return ok(null);
  return no(`${where}: no synthesisable type (declared ${JSON.stringify(schema.type ?? null)})`);
}

export interface SynthesizedRequest {
  /** null when the operation declares no JSON body, or when its schema could not be satisfied. */
  readonly body: Record<string, unknown> | null;
  readonly query: Readonly<Record<string, string>>;
  readonly source: "openapi" | "no-operation" | "no-body-schema" | "unsatisfiable";
  /** Non-empty when something could not be built; the sweep records this instead of a verdict. */
  readonly unsatisfiable: readonly string[];
}

const EMPTY_QUERY: Readonly<Record<string, string>> = Object.freeze({});

/**
 * The minimal request the contract says this operation accepts.
 *
 * `source` is recorded on every outcome so a route probed with a synthesised body can never be
 * confused with one probed with `{}` — a sweep that cannot say which of the two it sent cannot
 * defend either result.
 */
export function synthesizeRequest(verb: string, routePath: string, nonce = ""): SynthesizedRequest {
  const operation = findOperation(verb, routePath);
  if (!operation)
    return { body: null, query: EMPTY_QUERY, source: "no-operation", unsatisfiable: [`${verb} ${routePath} is not in openapi.json`] };

  const problems: string[] = [];
  const query: Record<string, string> = {};
  for (const parameter of operation.parameters ?? []) {
    if (parameter.in !== "query" || parameter.required !== true) continue;
    if (!parameter.schema) {
      problems.push(`query.${parameter.name}: required but has no schema`);
      continue;
    }
    // The query is left deterministic: it carries filters and dates, not the unique columns a
    // repeated write collides on, and a nonce there would make the three urls differ needlessly.
    const attempt = synthesizeValue(parameter.schema, `query.${parameter.name}`, new Set());
    if (!attempt.ok) problems.push(attempt.why);
    else query[parameter.name] = String(attempt.value);
  }

  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  if (!schema)
    return {
      body: null,
      query,
      source: problems.length > 0 ? "unsatisfiable" : "no-body-schema",
      unsatisfiable: problems,
    };

  const attempt = synthesizeValue(schema, "body", new Set(), nonce);
  if (!attempt.ok)
    return { body: null, query, source: "unsatisfiable", unsatisfiable: [...problems, attempt.why] };

  const value = attempt.value;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {
      body: null,
      query,
      source: "unsatisfiable",
      unsatisfiable: [...problems, `body: the contract's root schema is not an object`],
    };
  return { body: value as Record<string, unknown>, query, source: "openapi", unsatisfiable: problems };
}

/** Appends the synthesised required query parameters to a url that may already carry some. */
export function withQuery(url: string, query: Readonly<Record<string, string>>): string {
  const entries = Object.entries(query);
  if (entries.length === 0) return url;
  const search = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  return url.includes("?") ? `${url}&${search}` : `${url}?${search}`;
}
