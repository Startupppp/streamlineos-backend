import { KbAskService } from "./kb-ask.service";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";
import { NO_LINKED_DOCUMENTS } from "../../../test/kb-linked-document-ask-source.spec-fixtures";
import type { Db } from "../../../db/drizzle.module";

describe("KbAiInteractions — cross-tenant write isolation", () => {
  const ATTACKER = "org-attacker";
  const OWNER = "org-owner";

  function makeUser(orgId: string) {
    return {
      orgId,
      userId: "user-1",
      isOrgOwner: false,
      principal: ACCOUNT_ONLY_PRINCIPAL,
    } as never;
  }

  function buildDeps(hasContent = true) {
    const allInsertValues: Array<Record<string, unknown>> = [];
    const db: Record<string, unknown> = {
      execute: jest.fn().mockResolvedValue(hasContent ? [{ one: 1 }] : []),
      insert: jest.fn().mockImplementation(() => ({
        values: jest.fn().mockImplementation((row: Record<string, unknown>) => {
          allInsertValues.push(row);
          return Promise.resolve([]);
        }),
      })),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    };
    db.transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(db));

    const events = { record: jest.fn().mockResolvedValue(undefined) };
    const search = {
      retrieveTopArticles: jest.fn().mockResolvedValue([{
        kind: "article" as const, id: 1, title: "t",
        slug: "t", spaceId: 1, contentText: "text",
        updatedAt: new Date(),
      }]),
      retrieveTopSources: jest.fn().mockResolvedValue([]),
      retrieveDocumentPassages: jest.fn().mockResolvedValue([]),
      articleOwnerFilterFor: jest.fn().mockResolvedValue(null),
      articleRestrictionFilterFor: jest.fn().mockResolvedValue(null),
    };
    const citationVisibility = {
      visibleArticles: jest.fn().mockResolvedValue(new Set([1])),
      visiblePages: jest.fn().mockResolvedValue(new Set<number>()),
      visibleSources: jest.fn().mockResolvedValue(new Set<number>()),
    };
    const gateway = {
      invokeTextWithUsage: jest.fn().mockResolvedValue({
        ok: true, data: "answer", correlationId: "gw-1",
        aiUsage: { model: "m", promptTokens: 1, completionTokens: 1, totalTokens: 2, credits: 0, costUsd: 0 },
      }),
    };

    const svc = new KbAskService(
      db as unknown as Db,
      gateway as never,
      events as never,
      search as never,
      citationVisibility as never,
      NO_LINKED_DOCUMENTS,
    );

    return { svc, db, events, allInsertValues };
  }

  it("interaction row is written with the requesting org — never bleeds into another tenant", async () => {
    const { svc, allInsertValues } = buildDeps(true);

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    const interactionRows = allInsertValues.filter((r) => "correlationId" in r);
    expect(interactionRows.length).toBeGreaterThan(0);

    for (const row of interactionRows) {
      expect(row["orgId"]).toBe(ATTACKER);
      expect(row["orgId"]).not.toBe(OWNER);
    }
  });

  it("interaction rows written for two separate tenants carry different orgIds (positive pair)", async () => {
    const { svc: attackerSvc, allInsertValues: attackerInserted } = buildDeps(true);
    const { svc: ownerSvc, allInsertValues: ownerInserted } = buildDeps(true);

    await attackerSvc.ask(makeUser(ATTACKER), { question: "?" } as never);
    await ownerSvc.ask(makeUser(OWNER), { question: "?" } as never);

    const attackerRow = attackerInserted.find((r) => "correlationId" in r);
    const ownerRow = ownerInserted.find((r) => "correlationId" in r);

    expect(attackerRow?.["orgId"]).toBe(ATTACKER);
    expect(ownerRow?.["orgId"]).toBe(OWNER);
    expect(attackerRow?.["correlationId"]).not.toBe(ownerRow?.["correlationId"]);
  });

  it("events written for an Ask carry the requesting org — cross-tenant event injection is not possible", async () => {
    const { svc, events } = buildDeps(true);

    await svc.ask(makeUser(ATTACKER), { question: "test?" } as never);

    for (const [orgId] of events.record.mock.calls) {
      expect(orgId).toBe(ATTACKER);
      expect(orgId).not.toBe(OWNER);
    }
  });

  it("no-context path writes the event for the requesting org only", async () => {
    const { svc, events } = buildDeps(false);

    await svc.ask(makeUser(ATTACKER), { question: "?" } as never);

    for (const [orgId] of events.record.mock.calls) {
      expect(orgId).toBe(ATTACKER);
    }
  });
});
