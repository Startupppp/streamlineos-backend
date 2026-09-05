import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { allocateTicketNumbers } from "./allocate-ticket-number";

const dialect = new PgDialect();
function renderSql(q: SQL): string {
  return dialect.sqlToQuery(q).sql;
}

describe("allocateTicketNumbers – self-healing counter", () => {
  it(
    "query contains GREATEST and COALESCE(MAX(ticket_number)) so a counter " +
      "behind the seeded table self-heals on the next allocation",
    async () => {
      let capturedSql = "";

      const executor = {
        execute: jest.fn().mockImplementation((q: SQL) => {
          capturedSql = renderSql(q);
          return Promise.resolve([{ start: 1851 }]);
        }),
      };

      const result = await allocateTicketNumbers(executor, "org1", 21);

      expect(result).toBe(1851);

      expect(capturedSql).toContain("GREATEST");
      expect(capturedSql).toContain("COALESCE");
      expect(capturedSql).toContain("MAX(ticket_number)");
      expect(capturedSql).toContain("EXCLUDED.next_ticket_number");
    },
  );

  it("returns the value the database reports after the upsert", async () => {
    const executor = {
      execute: jest.fn().mockResolvedValue([{ start: 521 }]),
    };

    const result = await allocateTicketNumbers(executor, "org1", 1, 1);
    expect(result).toBe(521);
  });

  it("throws when the counter returns nothing", async () => {
    const executor = {
      execute: jest.fn().mockResolvedValue([]),
    };

    await expect(allocateTicketNumbers(executor, "org1", 1)).rejects.toThrow(
      "counter did not return a value",
    );
  });

  it("rejects count < 1", async () => {
    const executor = { execute: jest.fn() };
    await expect(allocateTicketNumbers(executor, "org1", 1, 0)).rejects.toThrow(
      "count must be at least 1",
    );
  });
});
