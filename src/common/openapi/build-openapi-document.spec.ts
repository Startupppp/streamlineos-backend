import { applyOperationContract, applyErrorResponses } from "./build-openapi-document";

describe("applyOperationContract", () => {
  it("makes a Zod query contract authoritative over stale Swagger metadata", () => {
    const operation = {
      operationId: "ReportsController_list",
      parameters: [
        {
          name: "limit",
          in: "query",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "unrelated",
          in: "header",
          required: false,
          schema: { type: "string" },
        },
      ],
    };

    applyOperationContract("get", operation, {
      query: {
        type: "object",
        required: ["cursor"],
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 100 },
          cursor: { type: "string" },
        },
      },
    });

    expect(operation.parameters).toEqual([
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100 },
      },
      {
        name: "unrelated",
        in: "header",
        required: false,
        schema: { type: "string" },
      },
      {
        name: "cursor",
        in: "query",
        required: true,
        schema: { type: "string" },
      },
    ]);
  });

  it("injects a 200 response schema for GET contracts with response", () => {
    const operation: Record<string, unknown> = { operationId: "FooController_get" };
    applyOperationContract("get", operation, {
      response: { type: "object", properties: { id: { type: "string" } } },
    });
    const responses = operation["responses"] as Record<string, unknown>;
    expect(responses).toBeDefined();
    const ok = responses["200"] as Record<string, unknown>;
    expect(ok).toBeDefined();
    expect(ok["description"]).toBe("OK");
    const schema = (ok["content"] as Record<string, unknown>)?.["application/json"] as Record<string, unknown>;
    expect((schema?.["schema"] as Record<string, unknown>)?.["type"]).toBe("object");
  });

  it("injects a 201 response schema for POST contracts with response", () => {
    const operation: Record<string, unknown> = { operationId: "FooController_create" };
    applyOperationContract("post", operation, {
      response: { type: "object", properties: { id: { type: "string" } } },
    });
    const responses = operation["responses"] as Record<string, unknown>;
    expect((responses?.["201"] as Record<string, unknown>)?.["description"]).toBe("Created");
  });

  it("stamps x-bodyless on operations with the bodyless flag", () => {
    const operation: Record<string, unknown> = { operationId: "FooController_activate" };
    applyOperationContract("post", operation, { bodyless: true });
    expect(operation["x-bodyless"]).toBe(true);
    expect(operation["requestBody"]).toBeUndefined();
  });
});

describe("applyErrorResponses", () => {
  it("adds 400 to all operations", () => {
    const op: Record<string, unknown> = { operationId: "X", "x-exposure": "public" };
    applyErrorResponses("get", "/items", op);
    const responses = op["responses"] as Record<string, unknown>;
    expect(responses?.["400"]).toEqual({ $ref: "#/components/responses/BadRequest" });
  });

  it("adds 401 to non-public operations but not public", () => {
    const pub: Record<string, unknown> = { operationId: "P", "x-exposure": "public" };
    applyErrorResponses("get", "/login", pub);
    expect((pub["responses"] as Record<string, unknown>)?.["401"]).toBeUndefined();

    const priv: Record<string, unknown> = { operationId: "Q", "x-exposure": "permissioned" };
    applyErrorResponses("get", "/items", priv);
    expect((priv["responses"] as Record<string, unknown>)?.["401"]).toEqual({ $ref: "#/components/responses/Unauthorized" });
  });

  it("adds 403 only to permissioned operations", () => {
    const universal: Record<string, unknown> = { operationId: "U", "x-exposure": "universal" };
    applyErrorResponses("get", "/me", universal);
    expect((universal["responses"] as Record<string, unknown>)?.["403"]).toBeUndefined();

    const perm: Record<string, unknown> = { operationId: "P", "x-exposure": "permissioned" };
    applyErrorResponses("get", "/items", perm);
    expect((perm["responses"] as Record<string, unknown>)?.["403"]).toEqual({ $ref: "#/components/responses/Forbidden" });
  });

  it("adds 404 only when path has a param", () => {
    const withParam: Record<string, unknown> = { operationId: "X", "x-exposure": "permissioned" };
    applyErrorResponses("get", "/items/{itemId}", withParam);
    expect((withParam["responses"] as Record<string, unknown>)?.["404"]).toBeDefined();

    const withoutParam: Record<string, unknown> = { operationId: "Y", "x-exposure": "permissioned" };
    applyErrorResponses("get", "/items", withoutParam);
    expect((withoutParam["responses"] as Record<string, unknown>)?.["404"]).toBeUndefined();
  });

  it("adds 409 and 422 for mutating methods but not GET", () => {
    const get: Record<string, unknown> = { operationId: "G", "x-exposure": "permissioned" };
    applyErrorResponses("get", "/items", get);
    const gr = get["responses"] as Record<string, unknown>;
    expect(gr?.["409"]).toBeUndefined();
    expect(gr?.["422"]).toBeUndefined();

    const post: Record<string, unknown> = { operationId: "C", "x-exposure": "permissioned" };
    applyErrorResponses("post", "/items", post);
    const pr = post["responses"] as Record<string, unknown>;
    expect(pr?.["409"]).toBeDefined();
    expect(pr?.["422"]).toBeDefined();
  });

  it("does not overwrite an existing response", () => {
    const op: Record<string, unknown> = {
      operationId: "X",
      "x-exposure": "permissioned",
      responses: { "400": { description: "Custom bad request" } },
    };
    applyErrorResponses("get", "/items", op);
    const r = op["responses"] as Record<string, unknown>;
    expect(r?.["400"]).toEqual({ description: "Custom bad request" });
  });
});
