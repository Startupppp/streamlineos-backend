import { ChatChannelMemberState } from "../chat-channel-member-state";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-test";
const CHANNEL = 1;
const USER = "user-1";
const MEMBERSHIP_ID = 42;

function makeDb() {
  return {
    query: {
      chatChannels: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: CHANNEL, isPrivate: false, entityType: null, entityId: null }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: MEMBERSHIP_ID, isOwner: false }),
      },
      chatChannelMembers: {
        findFirst: jest.fn().mockResolvedValue({ role: "MEMBER" }),
      },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue(undefined),
      }),
    }),
  };
}

describe("ChatChannelMemberState.muteChannel — exhaustive duration handling", () => {
  it("returns a mutedUntil 15 minutes ahead for '15m'", async () => {
    const before = Date.now();
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    const { mutedUntil } = await state.muteChannel(CHANNEL, USER, "15m", ORG);
    expect(mutedUntil.getTime()).toBeGreaterThanOrEqual(before + 900_000 - 50);
    expect(mutedUntil.getTime()).toBeLessThanOrEqual(Date.now() + 900_000 + 50);
  });

  it("returns a mutedUntil 1 hour ahead for '1h'", async () => {
    const before = Date.now();
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    const { mutedUntil } = await state.muteChannel(CHANNEL, USER, "1h", ORG);
    expect(mutedUntil.getTime()).toBeGreaterThanOrEqual(before + 3_600_000 - 50);
  });

  it("returns a mutedUntil 8 hours ahead for '8h'", async () => {
    const before = Date.now();
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    const { mutedUntil } = await state.muteChannel(CHANNEL, USER, "8h", ORG);
    expect(mutedUntil.getTime()).toBeGreaterThanOrEqual(before + 28_800_000 - 50);
  });

  it("returns a mutedUntil 24 hours ahead for '24h'", async () => {
    const before = Date.now();
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    const { mutedUntil } = await state.muteChannel(CHANNEL, USER, "24h", ORG);
    expect(mutedUntil.getTime()).toBeGreaterThanOrEqual(before + 86_400_000 - 50);
  });

  it("returns year 2099 for 'forever'", async () => {
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    const { mutedUntil } = await state.muteChannel(CHANNEL, USER, "forever", ORG);
    expect(mutedUntil.getFullYear()).toBe(2099);
  });

  it("throws on an unrecognised duration — no silent default to 15 minutes", async () => {
    const state = new ChatChannelMemberState(makeDb() as unknown as Db);
    await expect(
      Reflect.apply(state.muteChannel, state, [CHANNEL, USER, "UNKNOWN_DURATION", ORG]) as Promise<unknown>,
    ).rejects.toThrow(TypeError);
  });
});
