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
    service = new AblyService();
    Reflect.set(service, "apiKey", "app.key:secret");
  });

  it("grants chat and huddle only on channels the user belongs to", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7, 9]),
    );

    expect(capability["chat:org-1:7"]).toEqual(["subscribe", "publish", "history"]);
    expect(capability["chat:org-1:9"]).toEqual(["subscribe", "publish", "history"]);
    expect(capability["huddle:org-1:7"]).toEqual(["subscribe", "publish"]);
    expect(capability["chat:org-1:8"]).toBeUndefined();
  });

  it("never grants a wildcard chat or huddle capability", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    for (const resource of Object.keys(capability)) {
      const isOwnSignalChannel = resource === "huddle-signal:org-1:*:user-1";
      if (isOwnSignalChannel) continue;
      expect(resource).not.toContain("*");
    }
  });

  it("scopes huddle signalling to the caller and makes it subscribe-only", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", [7]),
    );

    expect(capability["huddle-signal:org-1:*:user-1"]).toEqual(["subscribe"]);
    expect(capability["huddle-signal:org-1:*"]).toBeUndefined();
  });

  it("grants notifications only on the caller's own channel", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", []),
    );

    expect(capability["notifications:org-1:user-1"]).toEqual(["subscribe"]);
    expect(capability["notifications:org-1:user-2"]).toBeUndefined();
  });

  it("issues no channel capability when the user belongs to nothing", () => {
    const { capability } = capabilityFor(service, () =>
      service.createChatTokenRequest("user-1", "org-1", []),
    );

    expect(Object.keys(capability).filter((r) => r.startsWith("chat:"))).toEqual([]);
  });

  it("does not let a support client publish", () => {
    const { capability } = capabilityFor(service, () =>
      service.createSupportTokenRequest("user-1", "org-1"),
    );

    expect(capability["support:org-1:*"]).not.toContain("publish");
  });
});
