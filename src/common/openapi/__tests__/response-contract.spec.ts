import { StreamableFile } from "@nestjs/common";
import { Readable } from "node:stream";
import { z } from "zod";
import {
  checkResponseAgainstContract,
  enforcesResponseContracts,
  isUnvalidatableBody,
  violationPaths,
} from "../response-contract.interceptor";
import { envelopeResponseSchema } from "../build-openapi-document";
import { nullableWireDate, wireDate } from "../wire-types";

/**
 * The response half of the contract, asserted on what the machinery DOES.
 *
 * `@ResponseSchema` reached `build-openapi-document` and nothing else: the declared
 * shape was never compared against a value, so a schema could be wrong from the day it
 * was written and no test, gate or typecheck would say so. These assertions are about
 * that comparison — that a drifted field is caught, that the envelope does not hide
 * it, that a stream is not mistaken for drift, and that a violation report cannot
 * carry the payload into a log line.
 *
 * The drift cases are the two that actually shipped, transposed onto a contract: a
 * field the service RENAMED and a field it stopped sending. Both typecheck clean on
 * both sides, which is why the assertion is on the runtime comparison and not on a
 * type.
 */
describe("response contract enforcement", () => {
  const contract = z.object({
    id: z.number().int(),
    user: z.object({ id: z.string(), name: z.string().nullable() }),
    startedAt: wireDate(),
  });

  const good = {
    id: 1,
    user: { id: "u1", name: "Ada Lovelace" },
    startedAt: new Date("2026-09-01T10:00:00Z"),
  };

  it("passes a response that matches the contract", () => {
    expect(checkResponseAgainstContract(contract, good)).toBeNull();
  });

  it("catches a field the service MOVED — the shape that shipped as huddle tiles reading Unknown", () => {
    // The service emitted `membership.user` where the contract (and the client) declare
    // `user`. Both repositories typechecked clean when this shipped.
    const moved = { ...good, user: undefined, membership: { user: good.user } };
    expect(checkResponseAgainstContract(contract, moved)).toEqual([
      expect.stringContaining("user:"),
    ]);
  });

  it("catches a field the service STOPPED SENDING", () => {
    const { startedAt: _dropped, ...missing } = good;
    expect(checkResponseAgainstContract(contract, missing)).toEqual([
      expect.stringContaining("startedAt:"),
    ]);
  });

  it("catches a field the service RETYPED", () => {
    expect(
      checkResponseAgainstContract(contract, { ...good, id: "1" }),
    ).toEqual([expect.stringContaining("id:")]);
  });

  it("allows an ADDED field — a backward-compatible deploy must not fail a running client", () => {
    expect(checkResponseAgainstContract(contract, { ...good, addedLater: true })).toBeNull();
  });

  describe("the ResponseTransformInterceptor envelope", () => {
    it("accepts the contract's shape inside { success, data }", () => {
      expect(
        checkResponseAgainstContract(contract, { success: true, data: good }),
      ).toBeNull();
    });

    it("reports the INNER field, not the envelope, when the enveloped body drifts", () => {
      // Reporting the outer parse here would say `id: invalid_type` about the envelope
      // and name no drifted field at all — a violation nobody could act on.
      const paths = checkResponseAgainstContract(contract, {
        success: true,
        data: { ...good, id: "1" },
      });
      expect(paths).toEqual([expect.stringContaining("id:")]);
    });

    it("does not unwrap a schema that declares its own success key", () => {
      const selfEnveloped = z.object({ success: z.boolean(), organizations: z.number() });
      expect(
        checkResponseAgainstContract(selfEnveloped, { success: true, organizations: 8 }),
      ).toBeNull();
    });
  });

  describe("bodies that cannot be compared are skipped, not reported", () => {
    it.each([
      ["undefined (204, or the handler wrote to res)", undefined],
      ["a StreamableFile", new StreamableFile(Buffer.from("x"))],
      ["a Readable", Readable.from(["x"])],
      ["a Buffer", Buffer.from("x")],
    ])("%s", (_label, value) => {
      expect(isUnvalidatableBody(value)).toBe(true);
      expect(checkResponseAgainstContract(contract, value)).toBeNull();
    });

    it("a plain object is comparable", () => {
      expect(isUnvalidatableBody(good)).toBe(false);
    });
  });

  it("reports paths and issue codes only — never the value", () => {
    const secret = "sk-live-000000000000";
    const paths = checkResponseAgainstContract(
      z.object({ token: z.number() }),
      { token: secret },
    );
    expect(paths).not.toBeNull();
    expect(paths?.join(" ")).not.toContain(secret);
    expect(paths).toEqual(["token: invalid_type"]);
  });

  it("caps the number of reported issues so one drifted array cannot flood a log line", () => {
    const wide = z.object(
      Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${String(i)}`, z.string()])),
    );
    const paths = checkResponseAgainstContract(wide, {});
    expect(paths).not.toBeNull();
    expect(paths?.length).toBeLessThanOrEqual(20);
  });

  it("de-duplicates the same path reported twice", () => {
    expect(
      violationPaths([
        { path: ["a", "b"], code: "invalid_type" },
        { path: ["a", "b"], code: "invalid_type" },
      ]),
    ).toEqual(["a.b: invalid_type"]);
  });

  it("names the root when the whole body is the wrong kind", () => {
    expect(violationPaths([{ path: [], code: "invalid_type" }])).toEqual([
      "(root): invalid_type",
    ]);
  });

  describe("the enforcing environment", () => {
    it("throws under test and observes everywhere else", () => {
      expect(enforcesResponseContracts("test")).toBe(true);
      expect(enforcesResponseContracts("development")).toBe(false);
      expect(enforcesResponseContracts("production")).toBe(false);
    });
  });
});

/**
 * The published document must describe the WIRE. Until 2026-09-03 it described the
 * handler's return value, so the one operation in the whole document that carried a
 * 2xx schema documented `{ sources }` while the wire carried
 * `{ success: true, data: { sources } }` — the single response contract this API
 * published was wrong about the field it named.
 */
describe("the published response schema is the envelope", () => {
  it("wraps a handler shape in { success, data }", () => {
    expect(envelopeResponseSchema({ type: "object", properties: { sources: {} } })).toEqual({
      type: "object",
      properties: {
        success: { type: "boolean", enum: [true] },
        data: { type: "object", properties: { sources: {} } },
      },
      required: ["success", "data"],
      additionalProperties: false,
    });
  });

  it("leaves a schema that already declares success alone", () => {
    const selfEnveloped = {
      type: "object",
      properties: { success: { type: "boolean" }, organizations: { type: "integer" } },
    };
    expect(envelopeResponseSchema(selfEnveloped)).toBe(selfEnveloped);
  });
});

/**
 * `wireDate` has two readers that disagree about when they see the value, and the
 * whole point of it is that ONE declaration answers both. A zod upgrade that changed
 * either half would otherwise re-introduce the `{}` this replaced — a property with no
 * declared type, which satisfies every consumer vacuously.
 */
describe("wireDate", () => {
  const jsonSchema = (schema: z.ZodType): Record<string, unknown> =>
    z.toJSONSchema(z.object({ at: schema }), {
      io: "input",
      unrepresentable: "any",
      target: "draft-7",
    })["properties"] as Record<string, unknown>;

  it("accepts the Date the handler returns", () => {
    expect(z.object({ at: wireDate() }).safeParse({ at: new Date() }).success).toBe(true);
  });

  it("rejects a string, so a service that pre-serialises is caught", () => {
    expect(z.object({ at: wireDate() }).safeParse({ at: "2026-01-01" }).success).toBe(false);
  });

  it("publishes string/date-time, not an empty schema", () => {
    expect(jsonSchema(wireDate())["at"]).toEqual({ type: "string", format: "date-time" });
  });

  it("publishes a nullable date as an anyOf and not as a contradictory pair", () => {
    expect(jsonSchema(nullableWireDate())["at"]).toEqual({
      anyOf: [{ type: "string", format: "date-time" }, { type: "null" }],
    });
  });
});
