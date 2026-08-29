import { applyOperationContract } from "./build-openapi-document";

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
});
