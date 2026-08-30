import { AutomationService } from "../automation.service";
import type { AutomationAction } from "../../../db/schema";

jest.mock("../../../common/security/ssrf-guard", () => ({
  checkWebhookUrl: jest.fn(),
}));

import { checkWebhookUrl } from "../../../common/security/ssrf-guard";

const mockCheckWebhookUrl = checkWebhookUrl as jest.MockedFunction<typeof checkWebhookUrl>;

const ACTIVE_ENDPOINT = {
  id: 1,
  url: "https://hooks.example.com/notify",
  secret: "secret-abc",
  events: [],
  isActive: true,
};

const makeDb = (endpoints: typeof ACTIVE_ENDPOINT[]) => ({
  query: {
    webhookEndpoints: {
      findMany: jest.fn().mockResolvedValue(endpoints),
    },
  },
  insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
} as never);

const mockNotifications = { create: jest.fn() } as never;
const mockEmail = { send: jest.fn() } as never;
const mockPlanLimits = { assertWithinLimit: jest.fn() } as never;
const mockAiNodeExecutor = { executeNode: jest.fn() } as never;

function makeSvc(db: ReturnType<typeof makeDb>) {
  return new AutomationService(db, mockNotifications, mockEmail, mockPlanLimits, mockAiNodeExecutor);
}

const WEBHOOK_ACTION: AutomationAction = {
  type: "webhook",
  config: { event: "ticket.created" },
};

const PAYLOAD = { ticketId: 42 };

beforeEach(() => {
  jest.resetAllMocks();
  globalThis.fetch = jest.fn();
});

describe("AutomationService — deliverWebhook SSRF guard", () => {
  it("blocks an internal endpoint URL and does not call fetch", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
    const db = makeDb([ACTIVE_ENDPOINT]);
    const svc = makeSvc(db);

    const result = await svc.executeAction("org-1", WEBHOOK_ACTION, PAYLOAD);

    expect(result).toMatchObject({ type: "webhook", ok: false });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("writes a failed log entry when SSRF guard blocks the endpoint", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: false, reason: "blocked-address" });
    const db = makeDb([ACTIVE_ENDPOINT]);
    const svc = makeSvc(db);

    await svc.executeAction("org-1", WEBHOOK_ACTION, PAYLOAD);

    expect(db.insert).toHaveBeenCalledTimes(1);
    const insertValuesCall = (db.insert as jest.Mock).mock.results[0]?.value as { values: jest.Mock };
    const [logRow] = insertValuesCall.values.mock.calls[0] as [Record<string, unknown>];
    expect(logRow.success).toBe(false);
    expect(String(logRow.responseBody)).toMatch(/SSRF/);
  });

  it("allows a legitimate external endpoint and calls fetch", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue("ok"),
    });
    const db = makeDb([ACTIVE_ENDPOINT]);
    const svc = makeSvc(db);

    const result = await svc.executeAction("org-1", WEBHOOK_ACTION, PAYLOAD);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string];
    expect(calledUrl).toBe(ACTIVE_ENDPOINT.url);
    expect(result).toMatchObject({ type: "webhook", ok: true });
  });

  it("proof — neutering the guard (always allowed) lets fetch reach any endpoint URL", async () => {
    mockCheckWebhookUrl.mockResolvedValue({ allowed: true });
    (globalThis.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue("ok"),
    });
    const internalEndpoint = { ...ACTIVE_ENDPOINT, url: "http://169.254.169.254/metadata" };
    const db = makeDb([internalEndpoint]);
    const svc = makeSvc(db);

    await svc.executeAction("org-1", WEBHOOK_ACTION, PAYLOAD);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = (globalThis.fetch as jest.Mock).mock.calls[0] as [string];
    expect(calledUrl).toBe("http://169.254.169.254/metadata");
  });

  it("skips dispatch when no active endpoints match", async () => {
    const db = makeDb([]);
    const svc = makeSvc(db);

    const result = await svc.executeAction("org-1", WEBHOOK_ACTION, PAYLOAD);

    expect(mockCheckWebhookUrl).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({ type: "webhook", ok: true });
  });
});
