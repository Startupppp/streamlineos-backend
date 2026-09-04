import Ably from "ably";
import { AblyService } from "./ably.service";

interface CapturedTokenParams {
  clientId: string;
  capability: Record<string, string[]>;
}

function capabilityFor(
  service: AblyService,
  build: () => Promise<Ably.TokenRequest>,
): CapturedTokenParams {
  let captured: CapturedTokenParams | null = null;
  const restStub = {
    auth: {
      createTokenRequest: (params: CapturedTokenParams) => {
        captured = params;
        return Promise.resolve({} as Ably.TokenRequest);
      },
    },
  };
  Reflect.set(service, "restClient", restStub);
  void build();
  if (!captured) throw new Error("createTokenRequest was not called");
  return captured;
}

describe("AblyService capabilities", () => {
  let service: AblyService;

  beforeEach(() => {
    service = new AblyService({ ABLY_API_KEY: undefined, CELL_ID: undefined });
    Reflect.set(service, "apiKey", "app.key:secret");
  });

  it("grants chat and huddle only on channels the user belongs to", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7, 9]),
    );

    expect(capability["cell:legacy-1:chat:org-1:7"]).toEqual(["subscribe", "publish", "history"]);
    expect(capability["cell:legacy-1:chat:org-1:9"]).toEqual(["subscribe", "publish", "history"]);
    expect(capability["cell:legacy-1:huddle:org-1:7"]).toEqual(["subscribe", "publish"]);
    expect(capability["cell:legacy-1:chat:org-1:8"]).toBeUndefined();
  });

  it("never grants a wildcard chat or huddle capability", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    for (const resource of Object.keys(capability)) {
      const isOwnSignalChannel = resource === "cell:legacy-1:huddle-signal:org-1:*:user-1";
      if (isOwnSignalChannel) continue;
      expect(resource).not.toContain("*");
    }
  });

  it("scopes huddle signalling to the caller and makes it subscribe-only", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    expect(capability["cell:legacy-1:huddle-signal:org-1:*:user-1"]).toEqual(["subscribe"]);
    expect(capability["cell:legacy-1:huddle-signal:org-1:*"]).toBeUndefined();
  });

  it("grants notifications only on the caller's own channel", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", []),
    );

    expect(capability["cell:legacy-1:notifications:org-1:user-1"]).toEqual(["subscribe"]);
    expect(capability["cell:legacy-1:notifications:org-1:user-2"]).toBeUndefined();
  });

  it("issues no per-channel capability when the user belongs to nothing", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", []),
    );

    // The org-wide presence channel is not a per-channel grant and is deliberately
    // excluded: it carries no messages, only the presence set, and a member with no
    // channels still has to be able to appear online.
    expect(
      Object.keys(capability).filter(
        (r) => r.includes(":chat:") && r !== "cell:legacy-1:chat:org-1:presence",
      ),
    ).toEqual([]);
  });

  /**
   * `useChatPresence` (frontend/features/chat/use-chat-presence.ts) enters the presence
   * set on `chat:{orgId}:presence`. Ably requires the `presence` operation to ENTER a
   * presence set — `subscribe` only reads it — and this capability map carried no key for
   * that channel at all, so every `presence.enter` was refused with a 403 the hook
   * swallows in its `.catch(() => {})`. Nobody ever appeared online and nothing said so.
   */
  it("grants the org-wide chat presence channel with the presence operation", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    expect(capability["cell:legacy-1:chat:org-1:presence"]).toEqual([
      "subscribe",
      "presence",
    ]);
  });

  it("scopes chat presence to the caller's own org and never lets it publish", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    expect(capability["cell:legacy-1:chat:org-2:presence"]).toBeUndefined();
    expect(capability["cell:legacy-1:chat:org-1:presence"]).not.toContain(
      "publish",
    );
    expect(capability["cell:legacy-1:chat:org-1:presence"]).not.toContain(
      "history",
    );
  });

  it("grants presence even when the caller belongs to no channel", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", []),
    );

    expect(capability["cell:legacy-1:chat:org-1:presence"]).toEqual([
      "subscribe",
      "presence",
    ]);
  });

  it("builds the presence channel name the frontend asks Ably for", () => {
    expect(service.presenceChannelName("org-1")).toBe(
      "cell:legacy-1:chat:org-1:presence",
    );
  });

  it("does not let a support client publish", () => {
    const { capability } = capabilityFor(service, () =>
      service.createSupportTokenRequest("user-1", "org-1", { wildcard: true }),
    );

    expect(capability["cell:legacy-1:support:org-1:*"]).not.toContain("publish");
  });

  it("grants the support wildcard only when the caller's scope is all", () => {
    const { capability } = capabilityFor(service, () =>
      service.createSupportTokenRequest("user-1", "org-1", { wildcard: true }),
    );

    expect(Object.keys(capability)).toEqual(["cell:legacy-1:support:org-1:*"]);
  });

  it("grants one channel per visible ticket when the caller is scoped", () => {
    const { capability } = capabilityFor(service, () =>
      service.createSupportTokenRequest("user-1", "org-1", { wildcard: false, ticketIds: [7, 9] }),
    );

    expect(Object.keys(capability).sort()).toEqual([
      "cell:legacy-1:support:org-1:7",
      "cell:legacy-1:support:org-1:9",
    ]);
    expect(capability["cell:legacy-1:support:org-1:*"]).toBeUndefined();
  });

  it("grants nothing when the caller has no support scope", () => {
    const { capability } = capabilityFor(service, () =>
      service.createSupportTokenRequest("user-1", "org-1", { wildcard: false, ticketIds: [] }),
    );

    expect(Object.keys(capability)).toEqual([]);
  });
});

describe("AblyService durable publish contract", () => {
  it("revokes a previously minted publish/subscribe token before the refreshed capability is narrowed", async () => {
    const service = new AblyService({ ABLY_API_KEY: "app.key:secret", CELL_ID: undefined });
    const revokeTokens = jest.fn().mockResolvedValue(undefined);
    let captured: CapturedTokenParams | undefined;
    Reflect.set(service, "restClient", {
      auth: {
        createTokenRequest: (params: CapturedTokenParams) => {
          captured = params;
          return Promise.resolve({} as Ably.TokenRequest);
        },
        revokeTokens,
      },
    });

    await service.createChatTokenRequest("removed-user", "org-1", [7]);
    expect(captured?.capability["cell:legacy-1:chat:org-1:7"]).toEqual([
      "subscribe",
      "publish",
      "history",
    ]);

    await service.revokeUserTokens("removed-user");
    expect(revokeTokens).toHaveBeenCalledWith([{ type: "clientId", value: "removed-user" }]);

    await service.createChatTokenRequest("removed-user", "org-1", []);
    expect(captured?.capability["cell:legacy-1:chat:org-1:7"]).toBeUndefined();
  });

  it("rejects a durable publish when Ably is not configured", async () => {
    const service = new AblyService({ ABLY_API_KEY: undefined, CELL_ID: undefined });
    await expect(service.publishChatMessage("org-1", 1, {} as never, {
      requireConfigured: true,
    })).rejects.toThrow("Ably is not configured");
  });

  it("propagates provider rejection so the outbox can retry", async () => {
    const service = new AblyService({ ABLY_API_KEY: "app.key:secret", CELL_ID: undefined });
    Reflect.set(service, "restClient", {
      channels: {
        get: () => ({ publish: jest.fn().mockRejectedValue(new Error("ably unavailable")) }),
      },
    });

    await expect(service.publishToUser(
      "org-1",
      "user-1",
      "notification:message",
      {},
      { requireConfigured: true },
    )).rejects.toThrow("ably unavailable");
  });
});
