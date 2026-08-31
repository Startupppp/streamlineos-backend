import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { SupportAiTranslationService } from "./support-ai-translation.service";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import type { OrgFeaturesService } from "../../ai/core/services/org-features.service";

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value") ? sqlValues(record.value, seen) : []),
  ];
}

describe("SupportAiTranslationService — cross-tenant isolation", () => {
  const ATTACKER_ORG = "org-attacker";
  const VICTIM_TICKET_ID = 101;
  const VICTIM_MSG_ID = 202;

  function makeDb(ticketRow: unknown): { db: Db; findTicket: jest.Mock } {
    const findTicket = jest.fn().mockResolvedValue(ticketRow);
    const db = {
      query: {
        supportTickets: { findFirst: findTicket },
        supportTicketMessages: { findFirst: jest.fn().mockResolvedValue(null) },
        supportTicketDrafts: { findFirst: jest.fn().mockResolvedValue(null) },
        supportMacros: { findFirst: jest.fn().mockResolvedValue(null) },
      },
    } as unknown as Db;
    return { db, findTicket };
  }

  function makeOrgFeatures(enabled: boolean): OrgFeaturesService {
    return {
      getFlags: jest.fn().mockResolvedValue({ supportAi: enabled }),
    } as unknown as OrgFeaturesService;
  }

  const aiGateway = {
    invokeStructured: jest.fn(),
  } as unknown as AiGatewayService;

  it("translateMessage throws NotFoundException(Ticket not found) when ticket belongs to a different org — cross-tenant isolation", async () => {
    const { db, findTicket } = makeDb(null);
    const svc = new SupportAiTranslationService(db, aiGateway, makeOrgFeatures(true));

    await expect(
      svc.translateMessage(ATTACKER_ORG, VICTIM_TICKET_ID, VICTIM_MSG_ID, "en"),
    ).rejects.toMatchObject({ message: "Ticket not found" });

    const callValues = sqlValues(findTicket.mock.calls[0]?.[0]?.where);
    expect(callValues).toContain(ATTACKER_ORG);
    expect(callValues).toContain(VICTIM_TICKET_ID);
  });

  it("translateDraft throws NotFoundException(Ticket not found) when ticket belongs to a different org — cross-tenant isolation", async () => {
    const { db, findTicket } = makeDb(null);
    const svc = new SupportAiTranslationService(db, aiGateway, makeOrgFeatures(true));

    await expect(
      svc.translateDraft(ATTACKER_ORG, VICTIM_TICKET_ID, "en", "some content"),
    ).rejects.toMatchObject({ message: "Ticket not found" });

    const callValues = sqlValues(findTicket.mock.calls[0]?.[0]?.where);
    expect(callValues).toContain(ATTACKER_ORG);
  });

  it("improveReply throws NotFoundException(Ticket not found) when ticket belongs to a different org — cross-tenant isolation", async () => {
    const { db, findTicket } = makeDb(null);
    const svc = new SupportAiTranslationService(db, aiGateway, makeOrgFeatures(true));

    await expect(
      svc.improveReply(ATTACKER_ORG, VICTIM_TICKET_ID, "some content"),
    ).rejects.toMatchObject({ message: "Ticket not found" });

    const callValues = sqlValues(findTicket.mock.calls[0]?.[0]?.where);
    expect(callValues).toContain(ATTACKER_ORG);
  });

  it("returns null (not attacker org data) when AI feature is disabled for org — short-circuit", async () => {
    const { db } = makeDb(null);
    const svc = new SupportAiTranslationService(db, aiGateway, makeOrgFeatures(false));

    const result = await svc.translateMessage(ATTACKER_ORG, VICTIM_TICKET_ID, VICTIM_MSG_ID, "en");

    expect(result).toBeNull();
    expect(aiGateway.invokeStructured).not.toHaveBeenCalled();
  });
});
