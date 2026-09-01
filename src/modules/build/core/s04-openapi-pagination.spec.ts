import { readFileSync } from "node:fs";
import { join } from "node:path";

interface OpenApiOperation {
  parameters?: Array<{ name?: string; in?: string }>;
  [key: string]: unknown;
}

interface OpenApiDocument {
  paths?: Record<string, Record<string, OpenApiOperation>>;
}

const document = JSON.parse(
  readFileSync(join(__dirname, "../../../../../../openapi.json"), "utf8"),
) as OpenApiDocument;

describe("S04 OpenAPI cursor coverage", () => {
  it.each([
    "/build/all-work",
    "/build/roadmap",
    "/build/feedback",
    "/build/changelog",
  ])("documents cursor pagination without legacy page parameters for %s", (path) => {
    const operation = document.paths?.[path]?.get;
    if (!operation) throw new Error(`missing GET ${path}`);
    const queryNames = (operation.parameters ?? [])
      .filter((parameter) => parameter.in === "query")
      .map((parameter) => parameter.name);

    expect(queryNames).toContain("cursor");
    expect(queryNames).toContain("limit");
    expect(queryNames).not.toContain("page");
    expect(queryNames).not.toContain("pageSize");
    expect(operation["x-exposure"]).toBe("permissioned");
  });
});
