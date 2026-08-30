import { HrAutomationActionsService } from "../hr-automation-actions.service";
import type { HrAutomationAction } from "../../../../db/schema/hr/automation-engine";

jest.mock("../../../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../../../../common/security/ssrf-guard";

const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

const mockDb = {
  insert: jest.fn(),
} as never;

const mockNotifications = { create: jest.fn() } as never;
const mockEmail = { send: jest.fn() } as never;
const mockWorkflowStarter = { startWorkflow: jest.fn() } as never;

function makeSvc() {
  return new HrAutomationActionsService(mockDb, mockNotifications, mockEmail, mockWorkflowStarter);
}

const WEBHOOK_ACTION: HrAutomationAction = {
  type: "call_webhook",
  config: { url: "https://hooks.example.com/notify", method: "POST" },
};

const PAYLOAD: Record<string, unknown> = { employeeId: "emp-1" };

beforeEach(() => {
  jest.resetAllMocks();
  globalThis.fetch = jest.fn();
});

describe("HrAutomationActionsService — call_webhook SSRF guard (async checkWebhookUrl)", () => {
  it("blocks an internal URL and returns status error without calling fetch", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });

    const svc = makeSvc();
    const result = await svc.execute("org-1", WEBHOOK_ACTION, PAYLOAD, null);

    expect(result).toMatchObject({ type: "call_webhook", ok: false });
    expect(result.error).toMatch(/SSRF/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("blocks an unresolvable hostname and returns status error", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "unresolvable-host" });

    const svc = makeSvc();
    const result = await svc.execute("org-1", WEBHOOK_ACTION, PAYLOAD, null);

    expect(result).toMatchObject({ type: "call_webhook", ok: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("allows a legitimate external URL to proceed and calls fetch", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const svc = makeSvc();
    const result = await svc.execute("org-1", WEBHOOK_ACTION, PAYLOAD, null);

    expect(result).toMatchObject({ type: "call_webhook", ok: true });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string];
    expect(calledUrl).toBe("https://hooks.example.com/notify");
  });

  it("proof — neutering the guard (always allowed) allows fetch to reach an internal URL", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    (globalThis.fetch as jest.Mock).mockResolvedValue({ ok: true });

    const svc = makeSvc();
    const internalAction: HrAutomationAction = {
      type: "call_webhook",
      config: { url: "http://169.254.169.254/metadata", method: "POST" },
    };
    const result = await svc.execute("org-1", internalAction, PAYLOAD, null);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ type: "call_webhook", ok: true });
  });

  it("calls checkWebhookUrl with the configured URL before any fetch", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });

    const svc = makeSvc();
    await svc.execute("org-1", WEBHOOK_ACTION, PAYLOAD, null);

    expect(mockCheckWebhookUrl).toHaveBeenCalledWith("https://hooks.example.com/notify");
  });
});
