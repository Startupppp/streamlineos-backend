import { applyOperationContract } from "./build-openapi-document";
import { isMultipartSpec, multipartSchema } from "./zod-operation-contracts";

describe("multipart operation contracts", () => {
  it("publishes the form fields the client actually sends, not just the file", () => {
    const schema = multipartSchema({ file: "file", fields: { folder: "string" } });

    expect(schema).toEqual({
      type: "object",
      properties: {
        file: { type: "string", format: "binary" },
        folder: { type: "string" },
      },
      required: ["file"],
    });
  });

  it("emits a multipart/form-data request body rather than application/json", () => {
    const operation: Record<string, unknown> = { operationId: "StorageController_upload" };

    applyOperationContract("post", operation, {
      multipart: multipartSchema({ file: "file", fields: { folder: "string" } }),
    });

    expect(operation.requestBody).toEqual({
      required: true,
      content: {
        "multipart/form-data": {
          schema: {
            type: "object",
            properties: {
              file: { type: "string", format: "binary" },
              folder: { type: "string" },
            },
            required: ["file"],
          },
        },
      },
    });
  });

  it("does not mark a multipart upload as bodyless", () => {
    const operation: Record<string, unknown> = { operationId: "KbMediaController_upload" };

    applyOperationContract("post", operation, {
      multipart: multipartSchema({ file: "file", fields: { pageId: "string" } }),
    });

    expect(operation["x-bodyless"]).toBeUndefined();
  });

  it("honours a required form field so a client cannot omit it silently", () => {
    const schema = multipartSchema({
      file: "file",
      fields: { spaceId: "string" },
      requiredFields: ["spaceId"],
    });

    expect(schema.required).toEqual(["file", "spaceId"]);
  });

  it("includes additional file fields alongside the primary file", () => {
    const schema = multipartSchema({
      file: "screenshot",
      fileRequired: false,
      additionalFiles: ["recording"],
      fields: { type: "string" },
    });

    expect(schema.properties).toMatchObject({
      screenshot: { type: "string", format: "binary" },
      recording: { type: "string", format: "binary" },
      type: { type: "string" },
    });
    expect((schema.required as string[] | undefined) ?? []).not.toContain("screenshot");
  });

  it("rejects metadata that names no file field", () => {
    expect(isMultipartSpec({ fields: { folder: "string" } })).toBe(false);
    expect(isMultipartSpec({ file: "" })).toBe(false);
    expect(isMultipartSpec(null)).toBe(false);
    expect(isMultipartSpec({ file: "file" })).toBe(true);
  });

  it("leaves a GET untouched because a body is meaningless there", () => {
    const operation: Record<string, unknown> = { operationId: "KbSourcesController_list" };

    applyOperationContract("get", operation, {
      multipart: multipartSchema({ file: "file" }),
    });

    expect(operation.requestBody).toBeUndefined();
  });
});
