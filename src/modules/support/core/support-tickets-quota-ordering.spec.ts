import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { SupportTicketsService } from "./support-tickets.service";
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

const ORG_ID = "org-quota-test";
const TICKET_ROW = { id: 1, orgId: ORG_ID, title: "Quota test ticket", status: "OPEN", priority: "MEDIUM" };

function buildMockTx() {
  return {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue(null) } },
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([TICKET_ROW]),
  };
}

describe("SupportTicketsService.createTicket — quota enforcement ordering", () => {
  let svc: SupportTicketsService;
  let mockDb: { transaction: jest.Mock; query: Record<string, Record<string, jest.Mock>> };
  let mockPlanLimits: { assertWithinLimit: jest.Mock };
  let mockTx: ReturnType<typeof buildMockTx>;

  beforeEach(async () => {
    jest.resetAllMocks();
    mockTx = buildMockTx();
    mockPlanLimits = { assertWithinLimit: jest.fn().mockResolvedValue(undefined) };

    mockDb = {
      query: {
        supportTickets: { findFirst: jest.fn().mockResolvedValue(null) },
      },
      transaction: jest.fn().mockImplementation(
        (fn: (tx: ReturnType<typeof buildMockTx>) => Promise<unknown>) => fn(mockTx),
      ),
    };

    const module = await Test.createTestingModule({
      providers: [
        SupportTicketsService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: PlanLimitsService, useValue: mockPlanLimits },
        {
          provide: CacheService,
          useValue: {
            cached: jest.fn((_k: string, f: () => Promise<unknown>) => f()),
            cachedVersioned: jest.fn((_n: string, _k: string, f: () => Promise<unknown>) => f()),
            invalidate: jest.fn().mockResolvedValue(undefined),
            invalidateNamespace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SupportMacrosService,
          useValue: {
            applyRoutingRules: jest.fn().mockResolvedValue({}),
            isVipClient: jest.fn().mockResolvedValue(false),
          },
        },
        {
          provide: SupportNotificationsService,
          useValue: { sendAssignmentEmail: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportRealtimeService,
          useValue: { publishTicketUpdated: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportSlaService,
          useValue: {
            resolvePolicy: jest.fn().mockResolvedValue({
              firstResponseTargetMins: 60,
              resolutionTargetMins: 1440,
              pauseStatuses: [],
              businessHours: null,
            }),
            computeDueDates: jest.fn((_p: unknown, from: Date) => ({
              firstResponseDueAt: new Date(from.getTime() + 60 * 60_000),
              resolutionDueAt: new Date(from.getTime() + 1440 * 60_000),
            })),
          },
        },
        {
          provide: AutomationService,
          useValue: { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportAiService,
          useValue: { runFullAnalysis: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportCustomFieldsService,
          useValue: { setFieldValues: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportTicketActivityService,
          useValue: { recordActivity: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: SupportTicketMessagesService,
          useValue: {},
        },
        {
          provide: SupportTicketOperationsService,
          useValue: {},
        },
      ],
    }).compile();

    svc = module.get(SupportTicketsService);
  });

  it("calls assertWithinLimit before starting the transaction that contains the insert", async () => {
    await svc.createTicket(ORG_ID, "user-1", { title: "Test ticket", description: "d" } as never, undefined, 1);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(mockPlanLimits.assertWithinLimit.mock.invocationCallOrder[0]).toBeLessThan(
      mockDb.transaction.mock.invocationCallOrder[0],
    );
  });

  it("calls assertWithinLimit with the correct key", async () => {
    await svc.createTicket(ORG_ID, "user-1", { title: "Test ticket", description: "d" } as never, undefined, 1);

    expect(mockPlanLimits.assertWithinLimit).toHaveBeenCalledWith(ORG_ID, "supportTickets");
  });

  it("does not start the insert transaction when quota is exhausted", async () => {
    mockPlanLimits.assertWithinLimit.mockRejectedValueOnce(
      new ForbiddenException("Support ticket limit reached."),
    );

    await expect(
      svc.createTicket(ORG_ID, "user-1", { title: "Test ticket", description: "d" } as never, undefined, 1),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });
});
