jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import { OutlookMailProvider } from "./outlook-mail.provider";
import type { ComposioGateway } from "../../integrations/core/composio.gateway";
import type { NormalizerConnectionMeta } from "./mail-normalizers";

/**
 * `listMessages` and `listMessagesForIngress` read the same Graph collection and
 * must end their pagination on the same signal: whether the SERVER filled the
 * page, not whether every row happened to normalise.
 *
 * `listMessages` counted normalised rows, so one message Graph returned in a
 * shape `outlookMessageSchema` rejects — a null `id`, an interpersonal message
 * carrying a field the schema does not admit — made a full page look short and
 * ended the caller's scroll. Every later message in that mailbox became
 * unreachable, silently and permanently, on a `nextSkip` that reads as "the
 * mailbox is exhausted" rather than as an error.
 */

const CONN: NormalizerConnectionMeta = {
  id: 7,
  composioAccountId: "conn-outlook",
  provider: "outlook",
  accountEmail: "b@example.test",
};

function message(index: number): Record<string, unknown> {
  return {
    id: `msg-${index}`,
    conversationId: `thread-${index}`,
    subject: `Subject ${index}`,
    from: { emailAddress: { address: "sender@example.test", name: "Sender" } },
    isRead: false,
    receivedDateTime: new Date(Date.UTC(2024, 0, 1, 12, 0, index)).toISOString(),
    hasAttachments: false,
    bodyPreview: "",
  };
}

/** Graph returned it; `outlookMessageSchema.parse` throws on the missing id. */
const UNPARSEABLE: Record<string, unknown> = { conversationId: "thread-x", subject: "no id" };

function buildProvider(items: unknown[]) {
  const executeTool = jest.fn().mockResolvedValue({ value: items });
  const gateway = { executeTool } as unknown as ComposioGateway;
  return { provider: new OutlookMailProvider(gateway), executeTool };
}

describe("OutlookMailProvider.listMessages — pagination end signal", () => {
  it("BITE: a full page containing one unparseable message still advances the cursor", async () => {
    const items = [...Array.from({ length: 9 }, (_, i) => message(i)), UNPARSEABLE];
    const { provider } = buildProvider(items);

    const page = await provider.listMessages("user-1", CONN, "inbox", 10, 0);

    expect(page.messages).toHaveLength(9);
    expect(page.nextSkip).toBe(10);
  });

  it("a genuinely short page still ends the scroll", async () => {
    const { provider } = buildProvider(Array.from({ length: 4 }, (_, i) => message(i)));

    const page = await provider.listMessages("user-1", CONN, "inbox", 10, 20);

    expect(page.messages).toHaveLength(4);
    expect(page.nextSkip).toBeNull();
  });

  it("a full page of parseable messages advances by the page size", async () => {
    const { provider } = buildProvider(Array.from({ length: 10 }, (_, i) => message(i)));

    const page = await provider.listMessages("user-1", CONN, "inbox", 10, 30);

    expect(page.messages).toHaveLength(10);
    expect(page.nextSkip).toBe(40);
  });

  it("agrees with listMessagesForIngress, which has always counted what the server returned", async () => {
    const items = [...Array.from({ length: 9 }, (_, i) => message(i)), UNPARSEABLE];
    const listPage = await buildProvider(items).provider.listMessages("user-1", CONN, "inbox", 10, 0);
    const ingressPage = await buildProvider(items).provider.listMessagesForIngress("user-1", CONN, "inbox", 10, 0);

    expect(listPage.nextSkip).toBe(ingressPage.nextSkip);
  });
});
