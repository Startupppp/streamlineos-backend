import { CrmAutomationRunnerService } from "../crm-automation-runner.service";
import type { StudioEventPayload } from "../types";

jest.mock("../../../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../../../../common/security/ssrf-guard";

const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

const mockDb = {} as never;
const mockNotifications = { create: jest.fn() } as never;
const mockEmail = { send: jest.fn() } as never;

const PAYLOAD: StudioEventPayload = {
  entityType: "lead",
  entityId: "1",
  data: { status: "qualified" },
};

describe("CrmAutomationRunnerService — call_webhook SSRF guard", () => {
  let svc: CrmAutomationRunnerService;

  beforeEach(() => {
    jest.resetAllMocks();
    svc = new CrmAutomationRunnerService(mockDb, mockNotifications, mockEmail);
  });

  it("blocks a request to an internal IP and returns status error", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });

    const result = await (svc as unknown as {
      executeAction: (
        orgId: string,
        actionKey: string,
        config: Record<string, unknown>,
        payload: StudioEventPayload,
      ) => Promise<{ status: string; message?: string }>
    }).executeAction("org1", "call_webhook", { url: "http://169.254.169.254/latest/meta-data/" }, PAYLOAD);

    expect(result.status).toBe("error");
    expect(result.message).toContain("SSRF");
    expect(mockCheckWebhookUrl).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data/");
  });

  it("proof — neutering the guard allows fetch to be called for an internal URL", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await (svc as unknown as {
      executeAction: (
        orgId: string,
        actionKey: string,
        config: Record<string, unknown>,
        payload: StudioEventPayload,
      ) => Promise<{ status: string; message?: string }>
    }).executeAction("org1", "call_webhook", { url: "http://169.254.169.254/latest/meta-data/" }, PAYLOAD);

    expect(result.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalledWith("http://169.254.169.254/latest/meta-data/", expect.anything());
    fetchSpy.mockRestore();
  });

  it("allows a legitimate external URL to proceed", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

    const result = await (svc as unknown as {
      executeAction: (
        orgId: string,
        actionKey: string,
        config: Record<string, unknown>,
        payload: StudioEventPayload,
      ) => Promise<{ status: string }>
    }).executeAction("org1", "call_webhook", { url: "https://hooks.example.com/crm" }, PAYLOAD);

    expect(result.status).toBe("ok");
    expect(fetchSpy).toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not call checkWebhookUrl when url is empty", async () => {
    const result = await (svc as unknown as {
      executeAction: (
        orgId: string,
        actionKey: string,
        config: Record<string, unknown>,
        payload: StudioEventPayload,
      ) => Promise<{ status: string }>
    }).executeAction("org1", "call_webhook", { url: "" }, PAYLOAD);

    expect(result.status).toBe("ok");
    expect(mockCheckWebhookUrl).not.toHaveBeenCalled();
  });
});
