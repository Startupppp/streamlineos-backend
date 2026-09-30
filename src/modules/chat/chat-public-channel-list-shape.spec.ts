import { ChatChannelListService } from "./chat-channel-list.service";
import { channelPublicListResponseSchema } from "./dto/chat-channels-response.schemas";

/** Every read resolves the next queued result, whatever builder methods precede the await. */
function makeDb(results: unknown[][]) {
  const select = () => {
    const rows = results.shift();
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown) => resolve(rows),
    };
    for (const method of ["from", "where", "orderBy", "limit", "groupBy"]) chain[method] = () => chain;
    return chain;
  };
  return {
    query: { organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 7 }) } },
    select,
  };
}

describe("listPublicChannels — response contract", () => {
  it("returns exactly the shape channelPublicListResponseSchema declares", async () => {
    const now = new Date();
    const db = makeDb([
      [{ id: 1, name: "general", description: null, avatarUrl: null, type: "PUBLIC", createdAt: now, lastMessageAt: now }],
      [{ channelId: 1, cnt: 3 }],
      [{ channelId: 1 }],
    ]);
    const service = new ChatChannelListService(db as never, {} as never);

    const result = await service.listPublicChannels("org-1", "user-1");

    expect(channelPublicListResponseSchema.strict().parse(result)).toEqual(result);
    expect(Object.keys(result.channels[0] ?? {}).sort()).toEqual(
      Object.keys(channelPublicListResponseSchema.shape.channels.element.shape).sort(),
    );
  });
});
