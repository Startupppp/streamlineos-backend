import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DealsCrudService } from "./deals-crud.service";
import { ScopedRead } from "../access/scoped-read";

/**
 * The deals list honoured `own` scope and reading one deal by id did not.
 *
 * `crm:deals:read` is declared `scopable: true`, so an organisation can grant a
 * rep `own` and expect them to see only their own deals. `listDeals` applies
 * `applyScope(..., { ownerColumn: deals.assignedToId })`. `getDeal`, ninety
 * lines below it in the same file, applied nothing — so the grant restricted the
 * list and nothing else, and the organisation believed otherwise.
 *
 * A deal carries its value, the contact's email and phone, and free-text notes.
 */

function dbWith(row: unknown) {
  const wheres: SQL[] = [];
  return {
    wheres,
    db: {
      query: {
        deals: {
          findFirst: (args: { where: SQL }) => {
            wheres.push(args.where);
            return Promise.resolve(row);
          },
        },
      },
    } as never,
  };
}

function serviceWith(db: unknown): DealsCrudService {
  const stub = {} as never;
  const planLimits = { assertWithinLimit: jest.fn(async () => {}) } as never;
  return new DealsCrudService(db as never, stub, stub, stub, stub, planLimits);
}

const sqlText = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

describe("reading one deal", () => {
  it("narrows to the caller's own deals at scope own", async () => {
    /*
     * The compiled predicate is the assertion. The fixture answers the same row
     * whatever the WHERE says, so "it returned nothing" would pass against the
     * unscoped version too.
     */
    const { db, wheres } = dbWith(undefined);
    const service = serviceWith(db);

    await service.getDeal("org-1", "rep-1", 5, ScopedRead.of("org-1", "rep-1", "own"));

    expect(sqlText(wheres[0] as SQL)).toContain('"assigned_to_id" =');
  });

  it("makes every deal unreachable at scope none", async () => {
    const { db, wheres } = dbWith(undefined);
    const service = serviceWith(db);

    await service.getDeal("org-1", "rep-1", 5, ScopedRead.of("org-1", "rep-1", "none"));

    expect(sqlText(wheres[0] as SQL)).toContain("false");
  });

  it("leaves a manager at scope all exactly as wide as they were", async () => {
    const { db, wheres } = dbWith(undefined);
    const service = serviceWith(db);

    await service.getDeal("org-1", "manager-1", 5, ScopedRead.of("org-1", "manager-1", "all"));

    expect(sqlText(wheres[0] as SQL)).not.toContain('"assigned_to_id" =');
  });

  it("applies the same scope to the source of a clone", async () => {
    // The route is gated on `crm:deals:create`, but the source is a READ: you
    // may copy a deal you could have opened. Unscoped, a rep could clone a
    // colleague's deal, reading its value, contact details and notes on the way.
    const { db, wheres } = dbWith(undefined);
    const service = serviceWith(db);

    await expect(service.cloneDeal("org-1", "rep-1", 5, ScopedRead.of("org-1", "rep-1", "own"))).rejects.toThrow(/not found/i);
    expect(sqlText(wheres[0] as SQL)).toContain('"assigned_to_id" =');
  });

  it("does not let the MCP tool hand the query a scope that is not one", () => {
    /*
     * `crm_get_deal` passed the literal string "global", which is not a member
     * of `DataScope`. It type-checked only because the service handle is `any`,
     * and it was harmless only because `getDeal` took two arguments and ignored
     * it — the scope had reached the query on neither path. `applyScope` fails
     * closed on an unknown value, so leaving it there would have made the tool
     * return nothing the moment the HTTP path started honouring the scope.
     */
    // The deal reads moved out of crm-mcp.service.ts into the tool handlers
    // when the service was split, and the service hands them its `decision`.
    // Both files are read, so neither can pass the literal.
    const source = readFileSync(
      join(__dirname, "..", "crm", "mcp", "lib", "crm-mcp-tool-handlers.ts"),
      "utf8",
    );
    const service = readFileSync(
      join(__dirname, "..", "crm", "mcp", "crm-mcp.service.ts"),
      "utf8",
    );
    // Matching the ARGUMENT, not the word: the comment explaining the fix names
    // "global" too, and an assertion that matched prose would fail on its own
    // documentation. The same self-reference broke a census earlier today.
    expect(source).not.toMatch(/,\s*"global"\s*\)/);
    expect(service).not.toMatch(/,\s*"global"\s*\)/);
    expect((source.match(/decision\.scope/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
