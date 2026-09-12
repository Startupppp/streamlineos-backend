import { ZodError } from "zod";
import { uploadDocumentMetaSchema } from "../dto/e-sign.schemas";

/**
 * The builder uploads to `POST /sign/documents/upload?envelopeId=<id>`, and
 * `@Validate({ query })` parses that whole query string strictly before the
 * handler runs. A schema that does not name `envelopeId` therefore refuses
 * every upload the product sends, with a 400 that reads like a client bug.
 */
describe("the document upload query contract", () => {
  it("binds the envelope the builder sends, coerced from the query string", () => {
    expect(uploadDocumentMetaSchema.parse({ envelopeId: "12" })).toEqual({ envelopeId: 12, orderIndex: 0 });
    expect(uploadDocumentMetaSchema.parse({ envelopeId: "12", orderIndex: "3" })).toEqual({
      envelopeId: 12,
      orderIndex: 3,
    });
  });

  it("still refuses an upload that names no envelope", () => {
    expect(() => uploadDocumentMetaSchema.parse({})).toThrow(ZodError);
    expect(() => uploadDocumentMetaSchema.parse({ envelopeId: "0" })).toThrow(ZodError);
  });

  it("stays strict about anything else", () => {
    expect(() => uploadDocumentMetaSchema.parse({ envelopeId: "12", orgId: "x" })).toThrow(ZodError);
  });
});
