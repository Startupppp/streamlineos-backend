import { ChatPinsService } from "../chat-pins.service";
import { chatPinsListResponseSchema } from "../dto/chat-misc-response.schemas";

/**
 * CHAT-012: the pins list is what the client parses after every pin. Its declared schema
 * required `reactions`, which the list never loaded, and `pinnedBy` is a user id string with
 * the person under `pinnedByUser` — the shape the frontend contract now mirrors.
 */
describe("ChatPinsService.listPins wire shape", () => {
  const now = new Date("2026-09-30T10:00:00Z");
  const actor = { orgId: "org-1", userId: "user-1", membershipId: 11 } as never;

  function buildService() {
    const db = {
      query: {
        chatChannels: {
          findFirst: jest.fn().mockResolvedValue({ id: 7, isPrivate: false, entityType: null, entityId: null }),
        },
        chatChannelMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
        chatPinnedMessages: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 3,
              orgId: "org-1",
              channelId: 7,
              messageId: 90,
              pinnedByMembershipId: 11,
              pinnedAt: now,
              pinnedByMembership: { userId: "user-1", user: { id: "user-1", name: "Asha" } },
              message: {
                id: 90,
                orgId: "org-1",
                channelId: 7,
                senderMembershipId: 12,
                content: "ship it",
                replyToId: null,
                isEdited: false,
                isDeleted: false,
                messageType: "text",
                metadata: null,
                actionStatus: null,
                clientKey: null,
                channelPosition: 4,
                createdAt: now,
                updatedAt: now,
                senderMembership: { userId: "user-2", user: { id: "user-2", name: "Ravi", image: null } },
                attachments: [],
                reactions: [{ emoji: "👍", membership: { userId: "user-1" } }],
              },
            },
          ]),
        },
      },
    };
    const entities = {
      withResolvedReferences: jest.fn(async (_actor: unknown, messages: unknown[]) => messages),
    };
    return new ChatPinsService(db as never, entities as never);
  }

  it("satisfies chatPinsListResponseSchema, with folded reactions and the pinner as an id", async () => {
    const pins = await buildService().listPins(7, actor);

    const parsed = chatPinsListResponseSchema.safeParse(pins);
    expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    expect(pins[0]).toMatchObject({
      pinnedBy: "user-1",
      pinnedByUser: { id: "user-1", name: "Asha" },
      message: { senderId: "user-2", reactions: { "👍": ["user-1"] } },
    });
  });
});
