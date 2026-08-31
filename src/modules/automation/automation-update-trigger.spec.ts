import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { updateAutomationRuleSchema } from "./dto/automation.schemas";
import { AutomationService } from "./automation.service";
import type { Db } from "../../db/drizzle.module";

const ORG = "org-1";

function makeDb(captured: { set?: Record<string, unknown>; where?: unknown }) {
  const returning = jest.fn().mockResolvedValue([{ id: 7, triggerEvent: "ticket.updated" }]);
  const where = jest.fn((condition: unknown) => {
    captured.where = condition;
    return { returning };
  });
  const set = jest.fn((values: Record<string, unknown>) => {
    captured.set = values;
    return { where };
  });
  return { update: jest.fn().mockReturnValue({ set }) } as unknown as Db;
}

function serviceWith(db: Db) {
  return new AutomationService(
    db,
    { create: jest.fn() } as never,
    { send: jest.fn() } as never,
    { dispatchWebhook: jest.fn() } as never,
    { assertWithinLimit: jest.fn() } as never,
    { executeNode: jest.fn() } as never,
  );
}

describe("settings automation rule — changing the trigger event", () => {
  it("accepts triggerEvent on update, so the editor's change is not silently stripped", () => {
    const parsed = updateAutomationRuleSchema.parse({ triggerEvent: "ticket.updated" });

    expect(parsed.triggerEvent).toBe("ticket.updated");
  });

  it("writes triggerEvent to the row rather than dropping it", async () => {
    const captured: { set?: Record<string, unknown>; where?: unknown } = {};
    const service = serviceWith(makeDb(captured));

    await service.updateRule(ORG, 7, { triggerEvent: "ticket.updated" });

    expect(captured.set).toMatchObject({ triggerEvent: "ticket.updated" });
  });

  it("leaves triggerEvent untouched when the caller omits it", async () => {
    const captured: { set?: Record<string, unknown>; where?: unknown } = {};
    const service = serviceWith(makeDb(captured));

    await service.updateRule(ORG, 7, { name: "renamed" });

    expect(captured.set).not.toHaveProperty("triggerEvent");
  });

  it("scopes the update to the caller's organisation", async () => {
    const captured: { set?: Record<string, unknown>; where?: unknown } = {};
    const service = serviceWith(makeDb(captured));

    await service.updateRule(ORG, 7, { triggerEvent: "ticket.updated" });

    const rendered = new PgDialect().sqlToQuery(captured.where as SQL);
    expect(rendered.sql).toContain("org_id");
    expect(rendered.params).toContain(ORG);
  });
});
