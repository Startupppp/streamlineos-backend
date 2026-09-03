import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ModuleChecklistService } from "./module-checklist.service";
import type { Db } from "../../../../db/drizzle.module";

const dialect = new PgDialect();
const ORG = "org-mc-a";

function staleItem(id: number, itemKey: string, required: boolean, sortOrder: number) {
  return {
    id,
    orgId: ORG,
    checklistId: 1,
    itemKey,
    title: "stale title",
    description: null,
    actionHref: null,
    status: "todo" as const,
    required,
    sortOrder,
    completedAt: null,
    skippedAt: null,
  };
}

/**
 * The seed reconciliation ran one UPDATE per stale item, keyed on the item id
 * alone — an N+1 on a read path (it runs on every checklist read, for every
 * module) and a write with no tenant predicate. One statement now, org_id bound.
 */
describe("ModuleChecklistService seed metadata sync", () => {
  function makeService(captured: { statements: SQL[]; updates: number }) {
    const db = {
      execute: jest.fn().mockImplementation((statement: SQL) => {
        captured.statements.push(statement);
        return Promise.resolve([]);
      }),
      update: jest.fn().mockImplementation(() => {
        captured.updates += 1;
        const chain: Record<string, unknown> = {};
        chain["set"] = jest.fn().mockReturnValue(chain);
        chain["where"] = jest.fn().mockResolvedValue(undefined);
        return chain;
      }),
    } as unknown as Db;
    return new ModuleChecklistService(db, {} as never, {} as never, {} as never);
  }

  it("reconciles every stale item in one statement, not one per item", async () => {
    const captured = { statements: [] as SQL[], updates: 0 };
    const service = makeService(captured);

    await service["syncItemMetadataFromSeed"]("crm", [
      staleItem(1, "import_contacts", false, 0),
      staleItem(2, "create_pipeline", true, 1),
      staleItem(3, "invite_sales_team", false, 2),
    ]);

    expect(captured.statements).toHaveLength(1);
    expect(captured.updates).toBe(0);
  });

  it("binds org_id on the reconciliation write", async () => {
    const captured = { statements: [] as SQL[], updates: 0 };
    const service = makeService(captured);

    await service["syncItemMetadataFromSeed"]("crm", [staleItem(1, "import_contacts", false, 0)]);

    const query = dialect.sqlToQuery(captured.statements[0] as SQL);
    expect(query.sql).toContain('"module_setup_checklist_items"."org_id" =');
    expect(query.params).toContain(ORG);
  });

  it("issues nothing when every item already matches its seed", async () => {
    const captured = { statements: [] as SQL[], updates: 0 };
    const service = makeService(captured);

    await service["syncItemMetadataFromSeed"]("crm", [
      {
        ...staleItem(1, "import_contacts", false, 0),
        title: "Import contacts/leads",
        actionHref: "/crm/contacts",
      },
    ]);

    expect(captured.statements).toHaveLength(0);
    expect(captured.updates).toBe(0);
  });
});
