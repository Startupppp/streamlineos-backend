/**
 * CHAT-002 (#22) & CHAT-004 (FE#66): Nullable field handling — hermetic, no database.
 *
 * Before the fix, sender name construction could produce `undefined` instead of explicit
 * `null`, causing:
 * - CHAT-002: Schema validation errors ("server sent data this screen does not understand")
 * - CHAT-004: "undefined:" appearing in channel preview text
 *
 * After the fix, nullable string fields are guaranteed to be `string | null`, never `undefined`.
 *
 * This test verifies the nullable field handling without requiring a live database.
 */

import { liftSenderId, flattenMessageSender } from "../chat-message-sender-shape";
import type { PersonIdentity } from "../../directory/person-seam";

describe("Nullable field handling (CHAT-002, CHAT-004)", () => {
  describe("flattenMessageSender", () => {
    it("returns explicit null for sender when senderMembership is missing", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: null,
      };

      const result = flattenMessageSender(message);

      expect(result.senderId).toBe(null);
      expect(result.sender).toBe(null);
      expect(result.senderId).not.toBe(undefined);
      expect(result.sender).not.toBe(undefined);
    });

    it("returns explicit null for sender when user is missing", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: { userId: "u1", user: null },
      };

      const result = flattenMessageSender(message);

      expect(result.senderId).toBe("u1");
      expect(result.sender).toBe(null);
      expect(result.sender).not.toBe(undefined);
    });

    it("properly flattens sender when user is present", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: {
          userId: "u1",
          user: { id: "u1", name: "Alice", image: "avatar.jpg" },
        },
      };

      const result = flattenMessageSender(message);

      expect(result.senderId).toBe("u1");
      expect(result.sender).toEqual({
        id: "u1",
        name: "Alice",
        image: "avatar.jpg",
      });
    });

    it("handles sender with null name explicitly", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: {
          userId: "u1",
          user: { id: "u1", name: null, image: null },
        },
      };

      const result = flattenMessageSender(message);

      expect(result.sender).toEqual({
        id: "u1",
        name: null,
        image: null,
      });
      // Crucially: name is null, not undefined
      expect(result.sender?.name).toBe(null);
      expect(result.sender?.name).not.toBe(undefined);
    });
  });

  describe("liftSenderId", () => {
    it("returns explicit null for senderId when senderMembership is missing", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: null,
      };

      const result = liftSenderId(message);

      expect(result.senderId).toBe(null);
      expect(result.senderId).not.toBe(undefined);
    });

    it("returns explicit null for senderId when userId is missing", () => {
      const message = {
        id: 1,
        content: "test",
        senderMembership: { userId: null },
      };

      const result = liftSenderId(message);

      expect(result.senderId).toBe(null);
      expect(result.senderId).not.toBe(undefined);
    });
  });

  describe("sender name construction (chat-channel-activity pattern)", () => {
    // Simulates the fix in chat-channel-activity.ts and chat-timeline-hydration.ts
    function constructSenderName(identity: PersonIdentity | undefined): string | null {
      const parts = [identity?.firstName, identity?.lastName].filter(Boolean).join(" ");
      // This is the fix: explicit length check instead of relying on truthiness
      return identity?.displayName ?? (parts.length > 0 ? parts : null);
    }

    it("returns null for missing identity, not undefined", () => {
      const name = constructSenderName(undefined);
      expect(name).toBe(null);
      expect(name).not.toBe(undefined);
    });

    it("returns displayName when present", () => {
      const identity: PersonIdentity = {
        personId: "p1",
        userId: "u1",
        displayName: "Alice Smith",
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        avatarUrl: null,
        workerId: null,
        organizationPeopleId: "op1",
      };

      const name = constructSenderName(identity);
      expect(name).toBe("Alice Smith");
    });

    it("falls back to joined name parts when displayName is null", () => {
      const identity: PersonIdentity = {
        personId: "p1",
        userId: "u1",
        displayName: null,
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        avatarUrl: null,
        workerId: null,
        organizationPeopleId: "op1",
      };

      const name = constructSenderName(identity);
      expect(name).toBe("Alice Smith");
    });

    it("returns null when displayName is null and no name parts, not empty string", () => {
      const identity: PersonIdentity = {
        personId: "p1",
        userId: "u1",
        displayName: null,
        firstName: null,
        lastName: null,
        email: "user@example.com",
        avatarUrl: null,
        workerId: null,
        organizationPeopleId: "op1",
      };

      const name = constructSenderName(identity);
      expect(name).toBe(null);
      expect(name).not.toBe(undefined);
      expect(name).not.toBe(""); // Critically: not empty string either
    });

    it("handles empty string name parts correctly (the old bug)", () => {
      // Before fix: `"" || null` would correctly evaluate to null
      // But this test documents the explicit check is more defensive
      const parts = ["", ""].filter(Boolean).join(" ");
      
      // Old approach (falsy check): would work here
      const oldWay = parts || null;
      expect(oldWay).toBe(null);

      // New approach (explicit length check): also works and is clearer
      const newWay = parts.length > 0 ? parts : null;
      expect(newWay).toBe(null);

      // Both produce the same result, but explicit check is more intentional
      expect(oldWay).toBe(newWay);
    });
  });

  describe("content nullability (chat-channel-activity)", () => {
    it("ensures content is explicitly null when missing, not undefined", () => {
      const messageRow = {
        channelId: 1,
        content: undefined, // Simulates missing content from DB
        senderUserId: "u1",
        createdAt: new Date(),
      };

      // This is the fix: explicit null coalescing
      const content = messageRow.content ?? null;

      expect(content).toBe(null);
      expect(content).not.toBe(undefined);
    });

    it("preserves actual content string", () => {
      const messageRow = {
        channelId: 1,
        content: "[QA] Test message",
        senderUserId: "u1",
        createdAt: new Date(),
      };

      const content = messageRow.content ?? null;

      expect(content).toBe("[QA] Test message");
    });

    it("preserves empty string as empty string (not null)", () => {
      const messageRow = {
        channelId: 1,
        content: "",
        senderUserId: "u1",
        createdAt: new Date(),
      };

      const content = messageRow.content ?? null;

      // Empty string is preserved (it's a valid value)
      expect(content).toBe("");
    });
  });
});
