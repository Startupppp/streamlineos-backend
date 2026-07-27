import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./index";

describe("drizzle schema graph", () => {
  it("has no relations object with an undefined table", () => {
    const broken = Object.entries(schema as Record<string, unknown>)
      .filter(([, value]) => {
        if (!value || typeof value !== "object") return false;
        if (!("table" in value)) return false;
        return (value as { table: unknown }).table === undefined;
      })
      .map(([name]) => name);

    expect(broken).toEqual([]);
  });

  it("constructs a drizzle client with the full schema", () => {
    const client = postgres("postgres://unused:unused@127.0.0.1:1/unused", {
      max: 1,
      connection: { application_name: "schema-relations-spec" },
    });
    try {
      expect(() => drizzle(client, { schema })).not.toThrow();
    } finally {
      void client.end({ timeout: 0 });
    }
  });
});
