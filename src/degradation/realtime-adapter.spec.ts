import { AblyService } from "../modules/realtime/ably.service";

function makeAbly(apiKey: string | undefined): AblyService {
  return new AblyService({ ABLY_API_KEY: apiKey });
}

describe("AblyService — realtime adapter absent (no key configured)", () => {
  let service: AblyService;

  beforeEach(() => {
    service = makeAbly(undefined);
  });

  it("is not configured when no API key is provided", () => {
    expect(service.configured).toBe(false);
  });

  it("publishChatEvent is a no-op — durable events survive without realtime delivery", async () => {
    await expect(service.publishChatEvent("org-1", 1, "message", {})).resolves.not.toThrow();
  });

  it("publishHuddleEvent is a no-op", async () => {
    await expect(service.publishHuddleEvent("org-1", 1, "join", {})).resolves.not.toThrow();
  });

  it("publishHuddleSignal is a no-op", async () => {
    await expect(service.publishHuddleSignal("org-1", 1, "user-2", {})).resolves.not.toThrow();
  });

  it("publishToUser without requireConfigured is a no-op", async () => {
    await expect(service.publishToUser("org-1", "user-1", "event", {})).resolves.not.toThrow();
  });

  it("publishChatMessage with requireConfigured throws so the caller knows delivery failed and can fall back", async () => {
    await expect(
      service.publishChatMessage("org-1", 1, {
        id: 1,
        channelId: 1,
        senderId: "user-1",
        senderName: "Alice",
        senderImage: null,
        content: "hello",
        createdAt: new Date(),
        replyToId: null,
        metadata: null,
        messageType: "text",
        attachments: [],
        idempotencyKey: "key-1",
      }, { requireConfigured: true }),
    ).rejects.toThrow("Ably is not configured");
  });

  it("revokeUserTokens is a no-op — the TTL backstop remains", async () => {
    await expect(service.revokeUserTokens("user-1")).resolves.not.toThrow();
  });

  it("publishSupportTicketEvent is a no-op", async () => {
    await expect(service.publishSupportTicketEvent("org-1", 42, "update", {})).resolves.not.toThrow();
  });
});

describe("Realtime channel naming — clients reconnect to the same channel from DB watermarks", () => {
  let service: AblyService;

  beforeEach(() => {
    service = makeAbly(undefined);
  });

  it("chat channel name encodes orgId and channelId so clients can reconnect deterministically", () => {
    const name = service.channelName("org-1", 42);
    expect(name).toBe("chat:org-1:42");
    expect(name).toContain("org-1");
    expect(name).toContain("42");
  });

  it("support channel name encodes orgId and ticketId", () => {
    const name = service.supportChannelName("org-1", 99);
    expect(name).toBe("support:org-1:99");
    expect(name).toContain("org-1");
    expect(name).toContain("99");
  });

  it("channel names are stable — the same inputs always produce the same name", () => {
    const a = service.channelName("org-stable", 7);
    const b = service.channelName("org-stable", 7);
    expect(a).toBe(b);
  });

  it("different orgs have distinct channel names — no cross-tenant channel bleed", () => {
    const a = service.channelName("org-a", 1);
    const b = service.channelName("org-b", 1);
    expect(a).not.toBe(b);
  });
});

describe("AblyService — realtime adapter present but publishing fails (fault server simulation)", () => {
  it.skip(
    "integration: when Ably REST endpoint is unreachable, publishChatMessage throws and the outbox event already committed is still present in Postgres — needs real Postgres + a fault server pointed at the Ably API URL",
    () => {},
  );

  it.skip(
    "integration: a client that reconnects after Ably was down reads from the DB lastReadAt watermark and catches up — needs a real Ably subscription and real Postgres",
    () => {},
  );
});
