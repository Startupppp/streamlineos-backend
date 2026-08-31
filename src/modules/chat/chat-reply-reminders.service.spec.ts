import { ChatReplyRemindersService } from "./chat-reply-reminders.service";

describe("ChatReplyRemindersService", () => {
  it("inserts reply reminders in bounded batches and excludes the sender", async () => {
    const members = Array.from({ length: 1_201 }, (_, index) => ({
      membershipId: index,
      membership: { userId: index === 0 ? "sender" : `member-${index}` },
    }));
    const insertedBatches: unknown[][] = [];
    const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn((batch: unknown[]) => {
      insertedBatches.push(batch);
      return { onConflictDoNothing };
    });
    const db = {
      query: {
        chatChannelMembers: {
          findMany: jest.fn().mockResolvedValue(members),
        },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
      })),
      insert: jest.fn(() => ({ values })),
    };
    const service = new ChatReplyRemindersService(db as never, {} as never, { CHAT_REPLY_REMINDER_MINUTES: 15 } as never);

    await service.scheduleForMessage("org-1", 42, 84, "sender");

    expect(insertedBatches.map((batch) => batch.length)).toEqual([500, 500, 200]);
    expect(onConflictDoNothing).toHaveBeenCalledTimes(3);
    expect(insertedBatches.flat()).not.toContainEqual(
      expect.objectContaining({ recipientMembershipId: 0 }),
    );
    expect(insertedBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          orgId: "org-1",
          channelId: 42,
          messageId: 84,
          recipientMembershipId: 1,
          senderMembershipId: 1,
        }),
      ]),
    );
  });

  it("does not issue an insert when the sender is the only channel member", async () => {
    const db = {
      query: {
        chatChannelMembers: {
          findMany: jest.fn().mockResolvedValue([{ membershipId: 0, membership: { userId: "sender" } }]),
        },
        organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) },
      },
      update: jest.fn(() => ({
        set: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
      })),
      insert: jest.fn(),
    };
    const service = new ChatReplyRemindersService(db as never, {} as never, { CHAT_REPLY_REMINDER_MINUTES: 15 } as never);

    await service.scheduleForMessage("org-1", 42, 84, "sender");

    expect(db.insert).not.toHaveBeenCalled();
  });
});
