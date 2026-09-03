import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ChatHuddleSignalsService } from "./chat-huddle-signals.service";
import { ChatChannelsService } from "./chat-channels.service";
import { ChatSavedService } from "./chat-saved.service";
import type { Db } from "../../db/drizzle.module";
import type { EntityActor } from "../entity-reference/entity-reference.types";

const stub = <T,>() => ({}) as T;

describe("chat — a channel, huddle or saved message outside the caller's org answers 404", () => {
  const ATTACKER_ORG = "org-attacker";
  const OWNER_ORG = "org-owner";

  describe("PATCH /chat/huddles/:huddleId/heartbeat", () => {
    function make(huddle: { id: number } | undefined, membership: { id: number } | undefined) {
      const where = jest.fn().mockResolvedValue(undefined);
      const set = jest.fn().mockReturnValue({ where });
      const db = {
        query: {
          chatHuddles: { findFirst: jest.fn().mockResolvedValue(huddle) },
          organizationMembers: { findFirst: jest.fn().mockResolvedValue(membership) },
        },
        update: jest.fn().mockReturnValue({ set }),
      } as unknown as Db;
      return {
        svc: new ChatHuddleSignalsService(db, stub<ConstructorParameters<typeof ChatHuddleSignalsService>[1]>()),
        update: db.update as unknown as jest.Mock,
      };
    }

    it("refuses a huddle id the org does not own instead of a no-op 200", async () => {
      const { svc, update } = make(undefined, { id: 3 });

      await expect(svc.heartbeat(1, "u-1", ATTACKER_ORG)).rejects.toThrow(NotFoundException);
      expect(update).not.toHaveBeenCalled();
    });

    it("keeps the heartbeat working for a huddle the org owns (control)", async () => {
      const { svc } = make({ id: 1 }, { id: 3 });

      await expect(svc.heartbeat(1, "u-1", OWNER_ORG)).resolves.toEqual({ ok: true });
    });
  });

  describe("POST /chat/channels/:channelId/refresh-name", () => {
    function make(channel: unknown) {
      const db = {
        query: { chatChannels: { findFirst: jest.fn().mockResolvedValue(channel) } },
      } as unknown as Db;
      return new ChatChannelsService(
        db,
        stub<ConstructorParameters<typeof ChatChannelsService>[1]>(),
        stub<ConstructorParameters<typeof ChatChannelsService>[2]>(),
        stub<ConstructorParameters<typeof ChatChannelsService>[3]>(),
        stub<ConstructorParameters<typeof ChatChannelsService>[4]>(),
      );
    }
    const actor = { orgId: ATTACKER_ORG, userId: "u-1", membershipId: 3 } as EntityActor;

    it("refuses a channel id the org does not own instead of answering success", async () => {
      await expect(make(undefined).reconcileEntityChannelDisplayName(1, actor)).rejects.toThrow(NotFoundException);
    });

    it("is a no-op for a channel the org owns that is not an entity channel (control)", async () => {
      const owned = { id: 1, name: "general", entityType: null, entityId: null };

      await expect(
        make(owned).reconcileEntityChannelDisplayName(1, { ...actor, orgId: OWNER_ORG }),
      ).resolves.toBeUndefined();
    });
  });

  describe("DELETE /chat/saved/:messageId", () => {
    function make(rows: Array<{ messageId: number }>) {
      const returning = jest.fn().mockResolvedValue(rows);
      const where = jest.fn().mockReturnValue({ returning });
      const db = { delete: jest.fn().mockReturnValue({ where }) } as unknown as Db;
      return new ChatSavedService(db, stub<ConstructorParameters<typeof ChatSavedService>[1]>());
    }
    const actor = { orgId: ATTACKER_ORG, userId: "u-1", membershipId: 3 } as EntityActor;

    it("refuses a message that is not on the caller's saved list", async () => {
      await expect(make([]).unsave(actor, 99)).rejects.toThrow(NotFoundException);
    });

    it("unsaves a message that is on the caller's list (control)", async () => {
      await expect(make([{ messageId: 99 }]).unsave({ ...actor, orgId: OWNER_ORG }, 99)).resolves.toEqual({
        ok: true,
      });
    });
  });

  describe("assertMember resolves the channel before the membership check", () => {
    function make(channel: unknown, member: unknown) {
      const db = {
        query: {
          organizationMembers: { findFirst: jest.fn().mockResolvedValue({ id: 3 }) },
          chatChannels: { findFirst: jest.fn().mockResolvedValue(channel) },
          chatChannelMembers: { findFirst: jest.fn().mockResolvedValue(member) },
          chatHuddles: { findFirst: jest.fn().mockResolvedValue({ id: 1, channelId: 1, status: "active" }) },
        },
        update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn() }) }),
      } as unknown as Db;
      return new ChatHuddleSignalsService(db, {
        publishHuddleEvent: jest.fn(),
      } as unknown as ConstructorParameters<typeof ChatHuddleSignalsService>[1]);
    }

    it("answers 404, not 403, for a channel the org does not own", async () => {
      await expect(make(undefined, undefined).setScreenShare(1, "u-1", true, ATTACKER_ORG)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("still answers 403 for an owned channel the caller is not a member of", async () => {
      await expect(
        make({ isArchived: false }, undefined).setScreenShare(1, "u-1", true, OWNER_ORG),
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
