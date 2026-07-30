import { Test, type TestingModule } from "@nestjs/testing";
import { SupportSlaService } from "./support-sla.service";
import { SupportNotificationsService } from "./support-notifications.service";
import { SupportMacrosService } from "./support-macros.service";
import { DRIZZLE } from "../../db/drizzle.constants";
import { AccessService } from "../access/access.service";

const mockDb = {
  query: {
    supportBusinessHours: { findMany: jest.fn(), findFirst: jest.fn() },
    supportSlaPolicies: { findMany: jest.fn(), findFirst: jest.fn() },
    supportTickets: { findFirst: jest.fn(), findMany: jest.fn() },
  },
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  selectDistinct: jest.fn().mockReturnThis(),
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
};

const mockNotifications = {
  sendEscalationEmail: jest.fn().mockResolvedValue(undefined),
};

const mockMacros = {
  applyRoutingRules: jest.fn().mockResolvedValue({}),
};

describe("SupportSlaService", () => {
  let service: SupportSlaService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.where.mockReset();
    mockDb.where.mockReturnThis();
    mockDb.query.supportTickets.findMany.mockReset();
    mockMacros.applyRoutingRules.mockResolvedValue({});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportSlaService,
        { provide: DRIZZLE, useValue: mockDb },
        { provide: SupportNotificationsService, useValue: mockNotifications },
        { provide: SupportMacrosService, useValue: mockMacros },
        {
          provide: AccessService,
          useValue: {
            membersWithPermission: jest
              .fn()
              .mockResolvedValue([
                { userId: "owner1", membershipId: 1 },
                { userId: "admin1", membershipId: 2 },
              ]),
          },
        },
      ],
    }).compile();
    service = module.get(SupportSlaService);
  });

  describe("computeRisk", () => {
    const baseTicket = {
      status: "OPEN" as const,
      createdAt: new Date(Date.now() - 1000), // created just now
      firstRespondedAt: null,
      firstResponseDueAt: new Date(Date.now() + 4 * 60 * 60 * 1000), // 4h window
      slaDeadline: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h window
      slaPausedAt: null,
    };

    it("returns 'ok' for resolved/closed tickets regardless of deadlines", () => {
      const risk = service.computeRisk({ ...baseTicket, status: "RESOLVED", slaDeadline: new Date("2020-01-01T00:00:00.000Z") });
      expect(risk).toBe("ok");
    });

    it("returns 'paused' when the ticket is currently SLA-paused", () => {
      const risk = service.computeRisk({ ...baseTicket, slaPausedAt: new Date() });
      expect(risk).toBe("paused");
    });

    it("returns 'first_response_breached' once the first-response due date has passed with no reply", () => {
      const risk = service.computeRisk({ ...baseTicket, firstResponseDueAt: new Date(Date.now() - 1000) });
      expect(risk).toBe("first_response_breached");
    });

    it("returns 'first_response_due_soon' when under 25% of the first-response window remains", () => {
      const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000); // created 3h ago
      const firstResponseDueAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min left, window was 3.5h
      const risk = service.computeRisk({ ...baseTicket, createdAt, firstResponseDueAt });
      expect(risk).toBe("first_response_due_soon");
    });

    it("does not flag 'due_soon' when comfortably within the first-response window", () => {
      const createdAt = new Date(Date.now() - 10 * 60 * 1000); // created 10 min ago
      const firstResponseDueAt = new Date(Date.now() + 3.5 * 60 * 60 * 1000); // ~3.5h left of a ~3h40m window
      const risk = service.computeRisk({ ...baseTicket, createdAt, firstResponseDueAt });
      expect(risk).toBe("ok");
    });

    it("returns 'resolution_breached' once the resolution deadline has passed", () => {
      const risk = service.computeRisk({
        ...baseTicket,
        firstRespondedAt: new Date(),
        slaDeadline: new Date(Date.now() - 1000),
      });
      expect(risk).toBe("resolution_breached");
    });

    it("skips first-response checks once the ticket has already been responded to", () => {
      const risk = service.computeRisk({
        ...baseTicket,
        firstRespondedAt: new Date(),
        firstResponseDueAt: new Date(Date.now() - 1000), // would breach if still checked
        slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
      });
      expect(risk).toBe("ok");
    });
  });

  describe("computePauseTransition", () => {
    it("starts a pause when entering a pause status", () => {
      const result = service.computePauseTransition("OPEN", "WAITING", ["WAITING"], null, 0);
      expect(result.slaPausedAt).toBeInstanceOf(Date);
      expect(result.extendByMinutes).toBe(0);
    });

    it("ends a pause and reports elapsed minutes when leaving a pause status", () => {
      const pausedAt = new Date(Date.now() - 15 * 60 * 1000); // paused 15 min ago
      const result = service.computePauseTransition("WAITING", "IN_PROGRESS", ["WAITING"], pausedAt, 5);
      expect(result.slaPausedAt).toBeNull();
      expect(result.extendByMinutes).toBeGreaterThanOrEqual(14);
      expect(result.slaPausedMinutes).toBeGreaterThanOrEqual(19);
    });

    it("is a no-op when the status change doesn't cross a pause boundary", () => {
      const result = service.computePauseTransition("OPEN", "IN_PROGRESS", ["WAITING"], null, 0);
      expect(result.slaPausedAt).toBeNull();
      expect(result.extendByMinutes).toBe(0);
    });
  });

  describe("runEscalations", () => {
    it("notifies the assignee and bumps the escalation level when a new threshold is crossed", async () => {
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "Broken checkout",
          status: "OPEN",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: "agent1",
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() - 1000), // breached
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 0,
        },
      ]);

      const result = await service.runEscalations("org1");

      expect(result).toEqual({ checked: 1, escalated: 1 });
      expect(mockNotifications.sendEscalationEmail).toHaveBeenCalledWith(
        "agent1",
        "Broken checkout",
        1,
        "first_response_breached",
      );
    });

    it("does not re-escalate a still-due-soon ticket that hasn't reached a breach yet", async () => {
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "Broken checkout",
          status: "OPEN",
          category: null,
          priority: "HIGH",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: "agent1",
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() + 30 * 60 * 1000), // still 30m out, due-soon territory
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 1, // already notified for due-soon
        },
      ]);

      const result = await service.runEscalations("org1");

      expect(result).toEqual({ checked: 1, escalated: 0 });
      expect(mockNotifications.sendEscalationEmail).not.toHaveBeenCalled();
    });

    it("treats a ticket still breached on a subsequent sweep as a repeat breach: re-notifies the assignee, escalates to managers, and attempts reassignment", async () => {
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "Broken checkout",
          status: "OPEN",
          category: "billing",
          priority: "URGENT",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: "agent1",
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() - 1000),
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 2, // already breached on a prior sweep
        },
      ]);
      mockMacros.applyRoutingRules.mockResolvedValueOnce({ assigneeId: "agent2" });
      // 1st where() call = the auto-reassign UPDATE (stays chainable); 2nd = the managers SELECT (resolves to rows).
      mockDb.where.mockReturnValueOnce(mockDb);
      mockDb.where.mockResolvedValueOnce([{ userId: "owner1" }, { userId: "admin1" }]);

      const result = await service.runEscalations("org1");

      expect(result).toEqual({ checked: 1, escalated: 1 });
      expect(mockNotifications.sendEscalationEmail).toHaveBeenCalledWith(
        "agent1",
        "Broken checkout",
        1,
        "first_response_breached",
      );
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ assigneeId: "agent2" }),
      );
      expect(mockNotifications.sendEscalationEmail).toHaveBeenCalledWith(
        "owner1",
        "Broken checkout",
        1,
        "first_response_breached",
      );
      expect(mockNotifications.sendEscalationEmail).toHaveBeenCalledWith(
        "admin1",
        "Broken checkout",
        1,
        "first_response_breached",
      );
    });

    it("does not reassign on repeat breach when routing rules resolve to the same assignee", async () => {
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "Broken checkout",
          status: "OPEN",
          category: "billing",
          priority: "URGENT",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: "agent1",
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() - 1000),
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 2,
        },
      ]);
      mockMacros.applyRoutingRules.mockResolvedValueOnce({ assigneeId: "agent1" });
      mockDb.where.mockResolvedValueOnce([]);

      await service.runEscalations("org1");

      expect(mockDb.set).not.toHaveBeenCalledWith(expect.objectContaining({ assigneeId: expect.anything() }));
    });

    it("skips notification when the ticket has no assignee, but still checks it", async () => {
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "Broken checkout",
          status: "OPEN",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: null,
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() - 1000),
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 0,
        },
      ]);

      const result = await service.runEscalations("org1");

      expect(result).toEqual({ checked: 1, escalated: 1 });
      expect(mockNotifications.sendEscalationEmail).not.toHaveBeenCalled();
    });
  });

  describe("runEscalationsForAllOrgs", () => {
    it("sweeps every org with at least one open ticket and aggregates the results", async () => {
      mockDb.where.mockResolvedValueOnce([{ orgId: "org1" }, { orgId: "org2" }]);
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([
        {
          id: 1,
          title: "org1 ticket",
          status: "OPEN",
          createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
          assigneeId: "agent1",
          firstRespondedAt: null,
          firstResponseDueAt: new Date(Date.now() - 1000),
          slaDeadline: new Date(Date.now() + 20 * 60 * 60 * 1000),
          slaPausedAt: null,
          slaEscalationLevel: 0,
        },
      ]);
      mockDb.query.supportTickets.findMany.mockResolvedValueOnce([]);

      const result = await service.runEscalationsForAllOrgs();

      expect(result).toEqual({ orgsProcessed: 2, checked: 1, escalated: 1 });
    });

    it("processes zero orgs without error when nothing has an open ticket", async () => {
      mockDb.where.mockResolvedValueOnce([]);

      const result = await service.runEscalationsForAllOrgs();

      expect(result).toEqual({ orgsProcessed: 0, checked: 0, escalated: 0 });
      expect(mockDb.query.supportTickets.findMany).not.toHaveBeenCalled();
    });
  });
});
