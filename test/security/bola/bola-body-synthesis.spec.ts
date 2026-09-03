import {
  findOperation,
  loadOpenApiDocument,
  synthesizeRequest,
  toContractPath,
  withQuery,
} from "./live/body-synthesis";
import { objectAddressableRoutes } from "./live/param-tables";

/**
 * Ticket 15, register item A-1 — the harness gap that hid 24% of the attack surface.
 *
 * The live sweep sent `{}` as the body of every mutating request. A `.strict()` Zod object with any
 * required field rejects that, so the OWN-TENANT CONTROL answered 400 and the route was filed
 * UNPROBEABLE — 468 of them, 41% of the unprobeable set. They were never asked whether they answer
 * another organization's id with a 404.
 *
 * This spec is the offline half: it proves a minimal valid request can be derived from the
 * committed contract for essentially the whole mutating surface, and that the derived request
 * actually satisfies the schema it was derived from. The seeded half re-runs the sweep with it.
 *
 * The validator below is written independently of the generator on purpose. A generator checked by
 * its own logic proves nothing; this one re-reads the schema and asks whether the value it was
 * handed is admissible, so a pattern the generator quietly ignored fails here.
 */

interface Schema {
  $ref?: string;
  type?: string | string[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  minItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  allOf?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  nullable?: boolean;
}

/**
 * A serialised `pattern` loses the flags its source regex carried, and `\p{L}` is inert without
 * `u` — the class then matches a literal "p". Reading it in unicode mode is what the runtime and
 * Zod do; reading it without would have failed a value that is genuinely admissible.
 */
function patternOf(pattern: string): RegExp {
  try {
    return new RegExp(pattern, "u");
  } catch {
    return new RegExp(pattern);
  }
}

function resolve(schema: Schema, depth: number): Schema {
  if (!schema.$ref || depth > 8) return schema;
  const name = schema.$ref.replace("#/components/schemas/", "");
  const target = (loadOpenApiDocument() as unknown as { components?: { schemas?: Record<string, Schema> } })
    .components?.schemas?.[name];
  return target ? resolve(target, depth + 1) : schema;
}

/** Returns the violations of `schema` by `value`; an empty array means the value is admissible. */
function violations(rawSchema: Schema, value: unknown, where = "$", depth = 0): string[] {
  if (depth > 12) return [];
  const schema = resolve(rawSchema, 0);
  const out: string[] = [];

  if (schema.const !== undefined && value !== schema.const) out.push(`${where}: not the const`);
  if (schema.enum && !schema.enum.includes(value)) out.push(`${where}: not in enum`);

  if (schema.allOf) for (const branch of schema.allOf) out.push(...violations(branch, value, where, depth + 1));

  const union = schema.oneOf ?? schema.anyOf;
  if (union && union.length > 0) {
    const anyOk = union.some((branch) => violations(branch, value, where, depth + 1).length === 0);
    if (!anyOk) out.push(`${where}: satisfies no union branch`);
    return out;
  }

  const declared = Array.isArray(schema.type) ? schema.type.filter((t) => t !== "null") : schema.type;
  const type = typeof declared === "string" ? declared : undefined;
  if (value === null) return schema.nullable === true || Array.isArray(schema.type) ? out : out;

  if (type === "string") {
    if (typeof value !== "string") return [...out, `${where}: expected string`];
    if (schema.pattern !== undefined && !patternOf(schema.pattern).test(value))
      out.push(`${where}: violates pattern ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < schema.minLength) out.push(`${where}: shorter than minLength`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) out.push(`${where}: longer than maxLength`);
    return out;
  }
  if (type === "integer" || type === "number") {
    if (typeof value !== "number") return [...out, `${where}: expected ${type}`];
    if (type === "integer" && !Number.isInteger(value)) out.push(`${where}: not an integer`);
    if (schema.minimum !== undefined && value < schema.minimum) out.push(`${where}: below minimum`);
    if (schema.maximum !== undefined && value > schema.maximum) out.push(`${where}: above maximum`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum)
      out.push(`${where}: at or below exclusiveMinimum`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum)
      out.push(`${where}: at or above exclusiveMaximum`);
    return out;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") out.push(`${where}: expected boolean`);
    return out;
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [...out, `${where}: expected array`];
    if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${where}: fewer than minItems`);
    if (schema.items) value.forEach((item, i) => out.push(...violations(schema.items as Schema, item, `${where}[${String(i)}]`, depth + 1)));
    return out;
  }
  if (type === "object" || schema.properties) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      return [...out, `${where}: expected object`];
    const record = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (!(name in record)) {
        out.push(`${where}.${name}: required but absent`);
        continue;
      }
      const property = schema.properties?.[name];
      if (property) out.push(...violations(property, record[name], `${where}.${name}`, depth + 1));
    }
    return out;
  }
  return out;
}

describe("SELF-TEST — the synthesiser satisfies the constraints it is given", () => {
  const synth = (schema: unknown): unknown => {
    const doc = loadOpenApiDocument() as unknown as { paths: Record<string, unknown> };
    doc.paths["/__selftest__"] = { post: { requestBody: { content: { "application/json": { schema } } } } };
    const result = synthesizeRequest("POST", "/__selftest__");
    delete doc.paths["/__selftest__"];
    return result.body;
  };

  it("populates required fields and omits optional ones", () => {
    expect(
      synth({
        type: "object",
        properties: { name: { type: "string", minLength: 1 }, note: { type: "string" } },
        required: ["name"],
      }),
    ).toEqual({ name: "bola-probe" });
  });

  it("picks the first enum member rather than inventing a value", () => {
    expect(
      synth({ type: "object", properties: { status: { type: "string", enum: ["OPEN", "CLOSED"] } }, required: ["status"] }),
    ).toEqual({ status: "OPEN" });
  });

  it("satisfies a date pattern no naive generator would match", () => {
    const body = synth({
      type: "object",
      properties: { day: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } },
      required: ["day"],
    }) as { day: string };
    expect(body.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("honours exclusiveMinimum instead of sending zero", () => {
    expect(
      synth({ type: "object", properties: { qty: { type: "integer", exclusiveMinimum: 0 } }, required: ["qty"] }),
    ).toEqual({ qty: 1 });
  });

  it("fills a non-empty array to its minItems and leaves an unconstrained one empty", () => {
    expect(
      synth({
        type: "object",
        properties: {
          ids: { type: "array", minItems: 2, items: { type: "integer", exclusiveMinimum: 0 } },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["ids", "tags"],
      }),
    ).toEqual({ ids: [1, 1], tags: [] });
  });

  it("recurses into a required nested object", () => {
    expect(
      synth({
        type: "object",
        properties: { filters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
        required: ["filters"],
      }),
    ).toEqual({ filters: { q: "bola-probe" } });
  });

  it("takes the first satisfiable union branch", () => {
    expect(
      synth({
        type: "object",
        properties: { subject: { oneOf: [{ type: "string", pattern: "^$never$" }, { type: "boolean" }] } },
        required: ["subject"],
      }),
    ).toEqual({ subject: true });
  });

  /**
   * The gate that keeps the sweep honest: an unsatisfiable schema must yield NO body and a reason,
   * so the route stays UNPROBEABLE rather than being sent a request that will 400 and be recorded
   * as though it had been asked.
   */
  it("refuses to guess, and says why, when no candidate satisfies the pattern", () => {
    const doc = loadOpenApiDocument() as unknown as { paths: Record<string, unknown> };
    doc.paths["/__selftest__"] = {
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { x: { type: "string", pattern: "^zzz-impossible-\\d{40}$" } }, required: ["x"] },
            },
          },
        },
      },
    };
    const result = synthesizeRequest("POST", "/__selftest__");
    delete doc.paths["/__selftest__"];
    expect(result.body).toBeNull();
    expect(result.source).toBe("unsatisfiable");
    expect(result.unsatisfiable[0]).toContain("no candidate satisfies pattern");
  });

  it("names an operation the contract does not carry rather than returning an empty body", () => {
    const result = synthesizeRequest("POST", "/no/such/route");
    expect(result.body).toBeNull();
    expect(result.source).toBe("no-operation");
  });
});

/**
 * A constant body collides with a unique index, and the collision lands on the THIRD request — the
 * absent-id control — which is exactly the one the sweep uses to tell a leak from a miss. Measured
 * on `POST /build/:projectId/labels` against `uniq_ticket_labels_org_name`: probe 201, control 201,
 * absent 500, verdict LEAK, disclosure nil.
 */
describe("NONCE — repeated writes must not collide, or the three-way control is worthless", () => {
  const bodyOf = (schema: unknown, nonce: string): unknown => {
    const doc = loadOpenApiDocument() as unknown as { paths: Record<string, unknown> };
    doc.paths["/__nonce__"] = { post: { requestBody: { content: { "application/json": { schema } } } } };
    const result = synthesizeRequest("POST", "/__nonce__", nonce);
    delete doc.paths["/__nonce__"];
    return result.body;
  };
  const NAMED = { type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"] };

  it("gives two requests different values for an unconstrained string", () => {
    expect(bodyOf(NAMED, "aaaa1111")).not.toEqual(bodyOf(NAMED, "bbbb2222"));
  });

  it("is deterministic with no nonce, so the offline coverage numbers stay reproducible", () => {
    expect(bodyOf(NAMED, "")).toEqual({ name: "bola-probe" });
  });

  it("never breaks a constraint to be unique — an enum, a const and a pattern all still win", () => {
    expect(bodyOf({ type: "object", properties: { s: { type: "string", enum: ["OPEN"] } }, required: ["s"] }, "zz")).toEqual({ s: "OPEN" });
    expect(
      bodyOf({ type: "object", properties: { d: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, required: ["d"] }, "zz"),
    ).toEqual({ d: "2027-01-15" });
  });

  it("keeps a nonced value inside its own length bounds", () => {
    const body = bodyOf(
      { type: "object", properties: { s: { type: "string", minLength: 20, maxLength: 24 } }, required: ["s"] },
      "abcd1234",
    ) as { s: string };
    expect(body.s.length).toBeGreaterThanOrEqual(20);
    expect(body.s.length).toBeLessThanOrEqual(24);
  });
});

describe("path translation and query assembly", () => {
  it("rewrites the harness's :param into the contract's {param}", () => {
    expect(toContractPath("/build/:projectId/bugs/:bugId")).toBe("/build/{projectId}/bugs/{bugId}");
  });

  it("finds a real operation through that translation", () => {
    expect(findOperation("GET", "/accounting/reports/customer-statement/:clientId")).not.toBeNull();
  });

  /**
   * 50 of the 468 are GET or DELETE: their control 400s on a missing required query parameter, not
   * on a body. "The probe sends no request body" is two thirds of the story.
   */
  it("synthesises the required query parameters a GET control was failing on", () => {
    const result = synthesizeRequest("GET", "/accounting/reports/customer-statement/:clientId");
    expect(Object.keys(result.query).sort()).toEqual(["from", "to"]);
    expect(result.query.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(withQuery("/accounting/reports/customer-statement/1", result.query)).toContain("?from=");
    expect(withQuery("/x?a=1", { b: "2" })).toBe("/x?a=1&b=2");
  });
});

describe("COVERAGE — the whole mutating surface, checked against its own schemas", () => {
  interface Op {
    verb: string;
    path: string;
    schema: Schema | undefined;
  }

  const mutating: Op[] = [];
  const doc = loadOpenApiDocument() as unknown as {
    paths: Record<string, Record<string, { requestBody?: { content?: Record<string, { schema?: Schema }> } }>>;
  };
  for (const [path, operations] of Object.entries(doc.paths))
    for (const [verb, operation] of Object.entries(operations)) {
      if (!["post", "put", "patch"].includes(verb)) continue;
      if (!operation.requestBody) continue;
      mutating.push({ verb: verb.toUpperCase(), path, schema: operation.requestBody.content?.["application/json"]?.schema });
    }

  const results = mutating.map((op) => ({
    op,
    result: synthesizeRequest(op.verb, op.path.replace(/\{([A-Za-z0-9_]+)\}/g, ":$1")),
  }));

  it("ANTI-VACUITY: the contract really does carry the 1,386 mutating bodies the gate counts", () => {
    expect(mutating.length).toBe(1386);
  });

  it("derives a body for every operation that declares a JSON one", () => {
    const json = results.filter((r) => r.op.schema !== undefined);
    const built = json.filter((r) => r.result.body !== null);
    const failed = json.filter((r) => r.result.body === null);
    process.stderr.write(
      `[bola-body-synthesis] ${String(built.length)}/${String(json.length)} JSON-bodied operations got a body ` +
        `(${String(results.length - json.length)} of ${String(results.length)} declare multipart only)\n`,
    );
    if (failed.length > 0)
      process.stderr.write(
        `[bola-body-synthesis] unsatisfiable: ${failed
          .slice(0, 10)
          .map((r) => `${r.op.verb} ${r.op.path} (${r.result.unsatisfiable[0] ?? "?"})`)
          .join(" | ")}\n`,
      );
    expect(failed.map((r) => `${r.op.verb} ${r.op.path}`)).toEqual([]);
  });

  /**
   * The nine that get no JSON body are multipart uploads. They are named rather than counted so
   * "9 unsatisfiable" can never quietly grow into "9 we stopped looking at" — a route that loses
   * its JSON schema and joins them fails the assertion above, not this one.
   */
  it("names the operations that carry no JSON body at all, so the residue cannot drift", () => {
    const multipart = results.filter((r) => r.op.schema === undefined).map((r) => `${r.op.verb} ${r.op.path}`).sort();
    expect(multipart).toEqual([
      "POST /hr/recruitment/candidates/{candidateId}/resume-parse",
      "POST /inventory/import/preview",
      "POST /kb/media",
      "POST /kb/sources",
      "POST /onboarding/documents",
      "POST /public/feedbucket/{publicKey}",
      "POST /public/feedbucket/{publicKey}/ai-assist",
      "POST /sign/documents/upload",
      "POST /storage/upload",
    ]);
  });

  it("every derived body satisfies the schema it was derived from, checked by an independent reader", () => {
    const bad: string[] = [];
    for (const { op, result } of results) {
      if (result.body === null || !op.schema) continue;
      const found = violations(op.schema, result.body);
      if (found.length > 0) bad.push(`${op.verb} ${op.path}: ${found.slice(0, 2).join("; ")}`);
    }
    process.stderr.write(`[bola-body-synthesis] ${String(bad.length)} bodies violate their own schema\n`);
    expect(bad).toEqual([]);
  });

  /**
   * The bite. `{}` — what the sweep sent for every route — is rejected by every operation that
   * declares a required field, and the synthesised body is accepted. Without this the coverage
   * numbers above could be met by a generator that emitted `{}` and called it a body.
   */
  it("BITE: the empty body the sweep used to send fails where the synthesised one passes", () => {
    let emptyRejected = 0;
    let synthesisedAccepted = 0;
    for (const { op, result } of results) {
      if (!op.schema || (op.schema.required ?? []).length === 0) continue;
      if (violations(op.schema, {}).length === 0) continue;
      emptyRejected += 1;
      if (result.body !== null && violations(op.schema, result.body).length === 0) synthesisedAccepted += 1;
    }
    process.stderr.write(
      `[bola-body-synthesis] {} is rejected by ${String(emptyRejected)} operations; the synthesised body is ` +
        `accepted by ${String(synthesisedAccepted)} of them\n`,
    );
    expect(emptyRejected).toBeGreaterThan(400);
    expect(emptyRejected - synthesisedAccepted).toBe(0);
  });
});

/**
 * CLOSED 2026-09-03 — and deliberately left as an empty list rather than deleted.
 *
 * All six routes 15e named here were absent from `openapi.json` because the artifact had gone 31
 * operations stale; `057adf02` regenerated it and every one is now described, so the sweep can
 * derive a body for the whole mutating object-addressable population. The constant stays so the
 * assertion below keeps its shape: a route that falls out of the contract again fails rather than
 * being absorbed, and re-opening the gap means adding a line here with a reason.
 */
const ABSENT_FROM_CONTRACT: readonly string[] = [];

describe("REACH — the object-addressable routes the sweep actually walks", () => {
  const routes = objectAddressableRoutes().filter((r) => ["POST", "PUT", "PATCH"].includes(r.verb));

  it("ANTI-VACUITY: the route surface still yields a mutating object-addressable population", () => {
    expect(routes.length).toBeGreaterThan(300);
  });

  it("equips every mutating object-addressable route the contract describes", () => {
    const missing: string[] = [];
    let equipped = 0;
    for (const route of routes) {
      const result = synthesizeRequest(route.verb, route.path);
      if (result.body !== null || result.source === "no-body-schema") equipped += 1;
      else missing.push(`${route.verb} ${route.path}`);
    }
    process.stderr.write(
      `[bola-body-synthesis] ${String(equipped)}/${String(routes.length)} mutating object-addressable routes are ` +
        `equipped from the contract\n`,
    );
    expect(missing.filter((route) => !ABSENT_FROM_CONTRACT.includes(route))).toEqual([]);
    expect(equipped).toBe(routes.length - ABSENT_FROM_CONTRACT.length);
  });

  /**
   * The cross-territory gap 15e pinned here is CLOSED: the six mutating routes that did not appear
   * in `openapi.json` are all described at head. The assertion is kept, not deleted — it is the
   * thing that would notice the gap re-opening, and an empty expectation is the strongest form it
   * has ever been in.
   */
  it("names the routes the contract does not describe, so the gap is owned rather than rounded away", () => {
    const absent = routes
      .filter((route) => synthesizeRequest(route.verb, route.path).source === "no-operation")
      .map((route) => `${route.verb} ${route.path}`)
      .sort();
    expect(absent).toEqual(ABSENT_FROM_CONTRACT);
  });
});
