jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { OutlookMailProvider } from "./outlook-mail.provider";
import type { ComposioGateway } from "../../integrations/core/composio.gateway";
import type { NormalizerConnectionMeta } from "./mail-normalizers";

/**
 * Graph's reply action takes a `message` of writeable properties to apply to the
 * reply it builds. `ccRecipients` has always ridden there; `toRecipients` is the
 * same field on the same payload, which is why honouring a sender-chosen
 * recipient needs no second call shape.
 *
 * The key is left off entirely when no recipient was chosen, rather than sent
 * empty — an empty `toRecipients` is a value Graph would apply, and applying it
 * would strip the recipient the reply came with.
 */
const CONN: NormalizerConnectionMeta = {
  id: 7,
  composioAccountId: "conn-outlook",
  provider: "outlook",
  accountEmail: "me@example.test",
};

function buildProvider() {
  const executeProxy = jest.fn().mockResolvedValue({});
  const gateway = { executeProxy } as unknown as ComposioGateway;
  return { provider: new OutlookMailProvider(gateway), executeProxy };
}

function payloadOf(executeProxy: jest.Mock): Record<string, unknown> {
  const call = executeProxy.mock.calls[0];
  if (!call) throw new Error("the provider never reached the gateway");
  return call[3] as Record<string, unknown>;
}

describe("OutlookMailProvider.replyToMessage — the chosen recipient reaches Graph", () => {
  it("BITE: a chosen recipient is carried as message.toRecipients", async () => {
    const { provider, executeProxy } = buildProvider();

    await provider.replyToMessage("user-1", CONN, "msg-1", "<p>hi</p>", [], "chosen@example.test");

    expect(payloadOf(executeProxy)).toEqual({
      comment: "<p>hi</p>",
      message: {
        ccRecipients: [],
        toRecipients: [{ emailAddress: { address: "chosen@example.test" } }],
      },
    });
  });

  it("carries cc alongside the chosen recipient", async () => {
    const { provider, executeProxy } = buildProvider();

    await provider.replyToMessage(
      "user-1", CONN, "msg-1", "<p>hi</p>", ["watcher@example.test"], "chosen@example.test",
    );

    expect(payloadOf(executeProxy)["message"]).toEqual({
      ccRecipients: [{ emailAddress: { address: "watcher@example.test" } }],
      toRecipients: [{ emailAddress: { address: "chosen@example.test" } }],
    });
  });

  it("omits toRecipients entirely when no recipient was chosen", async () => {
    const { provider, executeProxy } = buildProvider();

    await provider.replyToMessage("user-1", CONN, "msg-1", "<p>hi</p>", ["watcher@example.test"]);

    const message = payloadOf(executeProxy)["message"] as Record<string, unknown>;
    expect(message).not.toHaveProperty("toRecipients");
    expect(message["ccRecipients"]).toEqual([
      { emailAddress: { address: "watcher@example.test" } },
    ]);
  });

  it("still posts to the reply action on the addressed message", async () => {
    const { provider, executeProxy } = buildProvider();

    await provider.replyToMessage("user-1", CONN, "msg-1", "<p>hi</p>", [], "chosen@example.test");

    expect(executeProxy.mock.calls[0]?.slice(0, 3)).toEqual([
      "conn-outlook",
      "POST",
      "/me/messages/msg-1/reply",
    ]);
  });
});
