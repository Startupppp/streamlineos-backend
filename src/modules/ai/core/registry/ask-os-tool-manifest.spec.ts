import { z } from "zod";
import { toModelSchema } from "./ask-os-tool-manifest";

describe("the tool manifest carries nothing the model does not read", () => {
  it("drops $schema, which zod emits once per tool and costs 54 characters times the whole toolset", () => {
    const schema = toModelSchema(z.object({ note: z.string() }));

    expect(schema).not.toHaveProperty("$schema");
  });

  it("drops the safe-integer bound zod invents for .int(), which the model reads as a real 17-digit limit", () => {
    const schema = toModelSchema(z.object({ ticketId: z.number().int() }));
    const properties = schema.properties;

    expect(JSON.stringify(properties)).not.toContain("9007199254740991");
  });

  it("keeps a bound the caller actually declared", () => {
    const schema = toModelSchema(z.object({ limit: z.number().int().min(1).max(50) }));

    expect(JSON.stringify(schema)).toContain("\"maximum\":50");
    expect(JSON.stringify(schema)).toContain("\"minimum\":1");
  });

  it("prunes a nested object's artefacts too, not just the top level", () => {
    const schema = toModelSchema(
      z.object({ page: z.object({ size: z.number().int() }) }),
    );

    expect(JSON.stringify(schema)).not.toContain("9007199254740991");
  });

  it("prunes inside an array's item schema", () => {
    const schema = toModelSchema(
      z.object({ ids: z.array(z.number().int()) }),
    );

    expect(JSON.stringify(schema)).not.toContain("9007199254740991");
  });

  it("preserves the fields the model needs to call the tool correctly", () => {
    const schema = toModelSchema(
      z.object({ ticketId: z.number(), note: z.string().optional() }),
    );

    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(["ticketId"]);
    expect(Object.keys(schema.properties ?? {})).toEqual(["ticketId", "note"]);
  });

  it("drops additionalProperties:false which zod emits on every object and adds 26 chars of noise the model ignores", () => {
    const schema = toModelSchema(z.object({ name: z.string() }));

    expect(schema).not.toHaveProperty("additionalProperties");
  });

  it("drops additionalProperties:false from nested objects too", () => {
    const schema = toModelSchema(
      z.object({ inner: z.object({ value: z.string() }) }),
    );
    const innerProp = (schema.properties as Record<string, unknown> | undefined)?.inner;

    expect(innerProp).not.toHaveProperty("additionalProperties");
  });

  it("drops the verbose zod-generated regex pattern when a format hint is already present, keeping format for the model", () => {
    const schema = toModelSchema(z.object({ email: z.string().email() }));
    const emailProp = (schema.properties as Record<string, unknown> | undefined)?.email;

    expect(emailProp).toHaveProperty("format", "email");
    expect(emailProp).not.toHaveProperty("pattern");
  });

  it("keeps a caller-declared regex pattern on a plain string that has no format", () => {
    const schema = toModelSchema(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
    const dateProp = (schema.properties as Record<string, unknown> | undefined)?.date;

    expect(dateProp).toHaveProperty("pattern");
  });
});
