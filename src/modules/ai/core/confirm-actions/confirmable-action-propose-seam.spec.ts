import { Test } from "@nestjs/testing";
import { CONFIRMABLE_ACTIONS, CONFIRMABLE_ACTION_DEFINITIONS } from ".";
import { AiConfirmationService } from "../../confirmation/ai-confirmation.service";
import { stableHash } from "../../confirmation/ai-confirmation.helpers";
import { parseProposedPayload, registerProposeParsers } from "./confirmable-action.types";
import { AuditService } from "../../../../common/audit/audit.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";

process.env.AI_CONFIRMATION_SECRET = "test-secret-for-propose-seam-xxxxxxxxxx";

interface InsertedProposal {
  action: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  idempotencyKey: string | null;
}

function makeProposeDb(inserted: { row: InsertedProposal | null }) {
  const db: Record<string, unknown> = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
    insert: () => ({
      values: (values: InsertedProposal) => ({
        onConflictDoNothing: () => ({
          returning: () => {
            inserted.row = values;
            return Promise.resolve([{ ...values, id: 1, expiresAt: new Date(Date.now() + 60_000) }]);
          },
        }),
      }),
    }),
    execute: jest.fn().mockResolvedValue([]),
    transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => callback(db),
  };
  return db;
}

async function makeService(inserted: { row: InsertedProposal | null }) {
  const testingModule = await Test.createTestingModule({
    providers: [
      AiConfirmationService,
      { provide: DRIZZLE, useValue: makeProposeDb(inserted) },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();
  return testingModule.get(AiConfirmationService);
}

describe("propose is the single seam where a confirmable action's payload schema is applied", () => {
  let inserted: { row: InsertedProposal | null };
  let service: AiConfirmationService;

  beforeEach(async () => {
    inserted = { row: null };
    service = await makeService(inserted);
  });

  it("arms the seam by loading the confirm-actions barrel, because the service imports only the neutral parser and an unloaded registry would skip every schema", () => {
    expect(CONFIRMABLE_ACTIONS.length).toBeGreaterThan(0);
    expect(parseProposedPayload("ticket.addComment", { ticketId: "41", comment: "Hi" })).toEqual({
      ticketId: 41,
      comment: "Hi",
    });
  });

  it("refuses to boot rather than serve proposals with an unarmed registry, so dropping the barrel import fails loudly instead of silently disabling the schema", () => {
    expect(() => service.onModuleInit()).not.toThrow();

    registerProposeParsers([]);
    expect(() => service.onModuleInit()).toThrow(
      "Confirmable action parsers are not registered",
    );

    registerProposeParsers(CONFIRMABLE_ACTION_DEFINITIONS);
  });

  it("refuses the proposal when a tool sends a field the action's schema does not declare, rather than letting z.object strip it silently at confirm time", async () => {
    await expect(
      service.propose({
        orgId: "org-1",
        userId: "user-1",
        action: "ticket.addComment",
        payload: { ticketId: 41, comment: "Looks good", notifyEveryone: true },
      }),
    ).rejects.toThrow("would drop payload field(s) the card shows: notifyEveryone");
  });

  it("stores no proposal at all when the payload would be dropped, so a card is never shown for an action the executor cannot honour", async () => {
    await service
      .propose({
        orgId: "org-1",
        userId: "user-1",
        action: "ticket.addComment",
        payload: { ticketId: 41, comment: "Looks good", notifyEveryone: true },
      })
      .catch(() => undefined);

    expect(inserted.row).toBeNull();
  });

  it("stores the parsed payload, because the confirm executor receives the parsed form and the card must show what will actually run", async () => {
    await service.propose({
      orgId: "org-1",
      userId: "user-1",
      action: "ticket.addComment",
      payload: { ticketId: "41", comment: "Hi" },
    });

    expect(inserted.row?.payload).toEqual({ ticketId: 41, comment: "Hi" });
  });

  it("hashes the same object it stores, because confirm re-derives stableHash from the stored row and a hash over the unparsed form would 403 every confirmation", async () => {
    await service.propose({
      orgId: "org-1",
      userId: "user-1",
      action: "ticket.addComment",
      payload: { ticketId: "41", comment: "Hi" },
    });

    const row = inserted.row;
    expect(row).not.toBeNull();
    expect(stableHash(row?.payload ?? {})).toBe(row?.payloadHash);
  });

  it("applies a schema default at propose time, so the card and the executor agree on a value the tool never sent", async () => {
    await service.propose({
      orgId: "org-1",
      userId: "user-1",
      action: "ticket.create",
      payload: { projectId: 7, title: "Fix the confirmation card" },
    });

    expect(inserted.row?.payload).toEqual({
      projectId: 7,
      title: "Fix the confirmation card",
      type: "TASK",
      priority: "MEDIUM",
    });
  });

  it("leaves an action this registry does not own untouched, because meetings, inventory and automation redeem their own tokens against their own schemas", async () => {
    const payload = { eventId: 7, followUpSubject: "Recap", channel: "calendar" };

    await service.propose({
      orgId: "org-1",
      userId: "user-1",
      action: "meetings.send-follow-up",
      payload,
    });

    expect(inserted.row?.payload).toEqual(payload);
    expect(stableHash(inserted.row?.payload ?? {})).toBe(inserted.row?.payloadHash);
  });
});
