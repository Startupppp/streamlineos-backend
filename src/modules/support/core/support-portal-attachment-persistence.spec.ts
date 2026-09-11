import { Test, type TestingModule } from "@nestjs/testing";
import { supportTicketAttachments, supportTicketMessages, supportTickets } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { PlanLimitsService } from "../../billing/core/plan-limits.service";
import { SupportMacrosService } from "./support-macros.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportRealtimeService } from "./support-realtime.service";
import { SupportSlaService } from "./support-sla.service";
import { AutomationService } from "../../automation/automation.service";
import { SupportAiService } from "./support-ai.service";
import { SupportCustomFieldsService } from "./support-custom-fields.service";
import { SupportTicketActivityService } from "./support-ticket-activity.service";
import { SupportTicketMessagesService } from "./support-ticket-messages.service";
import { SupportTicketOperationsService } from "./support-ticket-operations.service";
import { SupportTicketsService } from "./support-tickets.service";
import { SupportPortalService } from "./support-portal.service";
import { SupportMentionsService } from "./support-mentions.service";

type Row = Record<string, unknown>;

/**
 * A recording double that keeps one array per table and answers the portal read
 * path from those arrays, so an assertion sees the rows the service actually
 * wrote and the shape `getMyTicket` actually returns — not a hand-written
 * fixture standing in for either.
 */
class FakeDb {
  readonly tickets: Row[] = [];
  readonly messages: Row[] = [];
  readonly attachments: Row[] = [];
  private nextId = 1;

  readonly query = {
    supportTickets: {
      findFirst: async () => this.tickets[0],
      findMany: async () => this.tickets,
    },
    supportTicketMessages: {
      findMany: async () =>
        this.messages.map((m) => ({
          ...m,
          author: { id: m.authorId, name: "Portal User", image: null },
          attachments: this.attachments
            .filter((a) => a.messageId === m.id)
            .map((a) => ({
              id: a.id,
              fileName: a.fileName,
              fileUrl: a.fileUrl,
              fileSize: a.fileSize,
              mimeType: a.mimeType,
            })),
        })),
    },
    organizationMembers: { findFirst: async () => undefined },
    users: { findFirst: async () => ({ name: "Portal User", email: "portal@example.com" }) },
  };

  private bucketFor(table: unknown): Row[] {
    if (table === supportTickets) return this.tickets;
    if (table === supportTicketMessages) return this.messages;
    if (table === supportTicketAttachments) return this.attachments;
    throw new Error("FakeDb: unexpected insert target");
  }

  insert(table: unknown) {
    const bucket = this.bucketFor(table);
    return {
      values: (input: Row | Row[]) => {
        const rows = (Array.isArray(input) ? input : [input]).map((r) => ({
          ...r,
          id: this.nextId++,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        bucket.push(...rows);
        const settled = Promise.resolve(rows);
        return Object.assign(settled, { returning: async () => rows });
      },
    };
  }

  update() {
    return { set: () => ({ where: async () => [] }) };
  }

  async transaction<T>(cb: (tx: FakeDb) => Promise<T>): Promise<T> {
    return cb(this);
  }
}

const noopCache = {
  cached: (_k: string, f: () => Promise<unknown>) => f(),
  cachedVersioned: (_n: string, _k: string, f: () => Promise<unknown>) => f(),
  invalidate: async () => undefined,
  invalidateNamespace: async () => undefined,
};

const ATTACHMENTS = [
  {
    fileName: "invoice.pdf",
    fileUrl: "support-attachments/abc-invoice.pdf",
    fileSize: 4096,
    mimeType: "application/pdf" as const,
  },
  {
    fileName: "screenshot.png",
    fileUrl: "support-attachments/def-screenshot.png",
    fileSize: 2048,
    mimeType: "image/png" as const,
  },
];

describe("support portal — attachments on the FIRST message", () => {
  let db: FakeDb;
  let portal: SupportPortalService;

  beforeEach(async () => {
    db = new FakeDb();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportPortalService,
        SupportTicketsService,
        SupportTicketMessagesService,
        { provide: DRIZZLE, useValue: db },
        { provide: CacheService, useValue: noopCache },
        { provide: PlanLimitsService, useValue: { assertWithinLimit: async () => undefined } },
        {
          provide: SupportMacrosService,
          useValue: { applyRoutingRules: async () => ({}), isVipClient: async () => false },
        },
        {
          provide: SupportNotificationsService,
          useValue: { sendAssignmentEmail: async () => undefined, sendReplyEmail: async () => undefined },
        },
        {
          provide: SupportRealtimeService,
          useValue: { publishTicketUpdated: async () => undefined, publishMessageCreated: async () => undefined },
        },
        {
          provide: SupportSlaService,
          useValue: {
            resolvePolicy: async () => ({ pauseStatuses: [], businessHours: null }),
            computeDueDates: () => ({ firstResponseDueAt: new Date(), resolutionDueAt: new Date() }),
          },
        },
        { provide: AutomationService, useValue: { runAutomationsForEvent: async () => undefined } },
        { provide: SupportAiService, useValue: { runFullAnalysis: async () => undefined } },
        {
          provide: SupportCustomFieldsService,
          useValue: { setFieldValues: async () => undefined, getFieldValues: async () => [] },
        },
        { provide: SupportTicketActivityService, useValue: { recordActivity: async () => undefined } },
        { provide: SupportMentionsService, useValue: { processMessageMentions: async () => undefined } },
        { provide: SupportTicketOperationsService, useValue: {} },
      ],
    }).compile();
    portal = module.get(SupportPortalService);
  });

  it("persists every attachment the portal sent, against the ticket's opening message", async () => {
    const created = await portal.createTicket("org1", "portal-user-1", 7, {
      title: "Printer will not start",
      category: "general",
      description: "It clicks twice and stops.",
      attachments: ATTACHMENTS,
    });

    expect(db.attachments).toHaveLength(2);
    expect(db.messages).toHaveLength(1);
    const openingMessage = db.messages[0];
    expect(openingMessage).toMatchObject({
      orgId: "org1",
      ticketId: created.id,
      authorId: "portal-user-1",
      body: "It clicks twice and stops.",
      isInternal: false,
      sourceChannel: "portal",
    });
    expect(db.attachments).toEqual([
      expect.objectContaining({
        orgId: "org1",
        messageId: openingMessage.id,
        fileName: "invoice.pdf",
        fileUrl: "support-attachments/abc-invoice.pdf",
        fileSize: 4096,
        mimeType: "application/pdf",
      }),
      expect.objectContaining({
        orgId: "org1",
        messageId: openingMessage.id,
        fileName: "screenshot.png",
        fileUrl: "support-attachments/def-screenshot.png",
        fileSize: 2048,
        mimeType: "image/png",
      }),
    ]);
  });

  it("returns those attachments from the portal read path", async () => {
    const created = await portal.createTicket("org1", "portal-user-1", 7, {
      title: "Printer will not start",
      category: "general",
      description: "It clicks twice and stops.",
      attachments: ATTACHMENTS,
    });

    db.tickets[0] = { ...db.tickets[0], id: created.id, createdByMembershipId: 7 };
    const read = await portal.getMyTicket("org1", "portal-user-1", 7, created.id);

    expect(read.messages).toHaveLength(1);
    expect(read.messages[0].attachments.map((a) => a.fileName)).toEqual([
      "invoice.pdf",
      "screenshot.png",
    ]);
    expect(read.messages[0].attachments[0]).toMatchObject({
      fileUrl: "support-attachments/abc-invoice.pdf",
      fileSize: 4096,
      mimeType: "application/pdf",
    });
  });

  it("writes no opening message when the portal sent no attachments", async () => {
    await portal.createTicket("org1", "portal-user-1", 7, {
      title: "Printer will not start",
      category: "general",
      description: "It clicks twice and stops.",
    });

    expect(db.messages).toHaveLength(0);
    expect(db.attachments).toHaveLength(0);
  });
});
