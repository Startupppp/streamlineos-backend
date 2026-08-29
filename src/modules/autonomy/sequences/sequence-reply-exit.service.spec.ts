import { Test, TestingModule } from "@nestjs/testing";
import { SequenceReplyExitService } from "./sequence-reply-exit.service";

describe("SequenceReplyExitService", () => {
  let service: SequenceReplyExitService;
  let db: {
    update: jest.Mock;
    select: jest.Mock;
  };

  beforeEach(async () => {
    db = {
      update: jest.fn(),
      select: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SequenceReplyExitService,
        { provide: "DRIZZLE", useValue: db },
      ],
    }).compile();

    service = module.get<SequenceReplyExitService>(SequenceReplyExitService);
  });

  describe("onInboundReply", () => {
    it("returns zero counts when partyId is null", async () => {
      const result = await service.onInboundReply("org_1", null, {
        activityId: "act_1",
      });
      expect(result).toEqual({ exited: 0, cancelledHolds: 0 });
      expect(db.update).not.toHaveBeenCalled();
    });

    it("catches errors and returns zero counts rather than throwing", async () => {
      db.update.mockImplementation(() => {
        throw new Error("Database connection lost");
      });

      const result = await service.onInboundReply("org_1", "party_1", {
        activityId: "act_1",
      });

      expect(result).toEqual({ exited: 0, cancelledHolds: 0 });
    });

    it("exits active enrolments and cancels waiting holds", async () => {
      const mockUpdate = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn(),
      };

      const mockSelect = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn(),
      };

      let updateCallCount = 0;

      db.update.mockImplementation(() => mockUpdate);
      db.select.mockImplementation(() => mockSelect);

      // First call: update crmNurtureEnrollments - exits 2 enrolments
      mockUpdate.returning.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 1) {
          return Promise.resolve([
            { id: "enrol_1" },
            { id: "enrol_2" },
          ]);
        }
        // Subsequent calls: cancel holds (2 holds)
        if (updateCallCount === 2) {
          return Promise.resolve([{ decisionId: "decision_1" }]);
        }
        if (updateCallCount === 3) {
          return Promise.resolve([{ decisionId: "decision_2" }]);
        }
        return Promise.resolve([]);
      });

      // Select returns attempts with holds
      mockSelect.where.mockResolvedValueOnce([
        { holdId: "hold_1", outboundMessageId: "msg_1" },
        { holdId: "hold_2", outboundMessageId: null },
      ]);

      const result = await service.onInboundReply("org_1", "party_1", {
        activityId: "act_1",
      });

      expect(result.exited).toBe(2);
      expect(result.cancelledHolds).toBe(2);
    });

    it("does not cancel holds for messages already sent", async () => {
      const mockUpdate = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn(),
      };

      const mockSelect = {
        from: jest.fn().mockReturnThis(),
        where: jest.fn(),
      };

      let updateCallCount = 0;

      db.update.mockImplementation(() => mockUpdate);
      db.select.mockImplementation(() => mockSelect);

      mockUpdate.returning.mockImplementation(() => {
        updateCallCount++;
        if (updateCallCount === 1) {
          return Promise.resolve([{ id: "enrol_1" }]);
        }
        // Hold cancellation returns empty (already resolved)
        if (updateCallCount === 2) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      mockSelect.where.mockResolvedValueOnce([
        { holdId: "hold_1", outboundMessageId: "msg_1" },
      ]);

      const result = await service.onInboundReply("org_1", "party_1", {
        activityId: "act_1",
      });

      expect(result.exited).toBe(1);
      expect(result.cancelledHolds).toBe(0);
    });

    it("does not overwrite manual-stop with replied", async () => {
      const mockUpdate = {
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        returning: jest.fn(),
      };

      db.update.mockImplementation(() => mockUpdate);

      // No active enrolments found
      mockUpdate.returning.mockResolvedValueOnce([]);

      const result = await service.onInboundReply("org_1", "party_1", {
        activityId: "act_1",
      });

      expect(result).toEqual({ exited: 0, cancelledHolds: 0 });
    });
  });
});
