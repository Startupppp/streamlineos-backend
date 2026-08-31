import { BadRequestException } from "@nestjs/common";
import { HrWebhooksService } from "../hr-webhooks.service";
import type { Db } from "../../../../db/drizzle.module";
import { type HrAutomationEvent } from "../hr-automation-events";

jest.mock("../../../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../../../../common/security/ssrf-guard";

const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

const mockInsertReturning = jest.fn();
const mockDb = {
  insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: mockInsertReturning }) }),
  update: jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  }),
  query: {
    hrWebhookSubscriptions: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org1", url: "https://ok.example.com", name: "w1" }),
    },
  },
} as unknown as Db;

function makeSvc() {
  return new HrWebhooksService(mockDb);
}

const VALID_INPUT = {
  name: "my-hook",
  url: "https://hooks.example.com/crm",
  events: ["employee.created"] as HrAutomationEvent[],
  isActive: true,
};

describe("HrWebhooksService — SSRF guard (shared checkWebhookUrl)", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockDb.insert = jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ returning: mockInsertReturning }) });
    mockInsertReturning.mockResolvedValue([{ id: 1, orgId: "org1", ...VALID_INPUT, secret: "s", createdBy: "u1", createdAt: new Date(), updatedAt: new Date(), deletedAt: null }]);
    mockDb.update = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([{ id: 1 }]) }),
      }),
    });
    mockDb.query = {
      hrWebhookSubscriptions: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: "org1", url: "https://ok.example.com", name: "w1" }),
      },
    } as never;
  });

  describe("createSubscription", () => {
    it("throws BadRequestException for an internal URL", async () => {
      mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
      const svc = makeSvc();

      await expect(
        svc.createSubscription("org1", "u1", { ...VALID_INPUT, url: "http://192.168.1.1/webhook" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockCheckWebhookUrl).toHaveBeenCalledWith("http://192.168.1.1/webhook");
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it("proof — neutering the guard allows insert to proceed for an internal URL", async () => {
      mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
      const svc = makeSvc();

      await expect(
        svc.createSubscription("org1", "u1", { ...VALID_INPUT, url: "http://192.168.1.1/webhook" }),
      ).resolves.toBeDefined();

      expect(mockDb.insert).toHaveBeenCalled();
    });

    it("allows a legitimate external URL to proceed", async () => {
      mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
      const svc = makeSvc();

      await expect(
        svc.createSubscription("org1", "u1", VALID_INPUT),
      ).resolves.toBeDefined();

      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe("updateSubscription", () => {
    it("throws BadRequestException when the new URL is internal", async () => {
      mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
      const svc = makeSvc();

      await expect(
        svc.updateSubscription("org1", 1, { url: "http://10.0.0.1/hook" }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mockCheckWebhookUrl).toHaveBeenCalledWith("http://10.0.0.1/hook");
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it("proof — neutering the guard allows DB update for an internal URL", async () => {
      mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
      const svc = makeSvc();

      await svc.updateSubscription("org1", 1, { url: "http://10.0.0.1/hook" }).catch(() => {});

      expect(mockDb.update).toHaveBeenCalled();
    });

    it("skips the SSRF check when url is absent in the update input", async () => {
      const svc = makeSvc();

      await svc.updateSubscription("org1", 1, { isActive: false }).catch(() => {});

      expect(mockCheckWebhookUrl).not.toHaveBeenCalled();
    });
  });
});
