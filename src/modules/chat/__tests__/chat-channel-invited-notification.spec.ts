import { ChatChannelMembersImplementation } from "../chat-channel-members-implementation";
import { ChatNotificationsService } from "../chat-notifications.service";
import { CHAT_NOTIFICATION_EVENTS } from "../../notifications/notification-events-chat.catalog";
import type { Db } from "../../../db/drizzle.module";
import type { EntityReferenceService } from "../../entity-reference/entity-reference.types";
import { ChatModule } from "../chat.module";

jest.mock("../chat-channel-authorization", () => ({
  assertChannelAccess: jest.fn(),
  assertChannelAdmin: jest.fn(),
  assertChannelMember: jest.fn(),
  assertEntityAccess: jest.fn(),
  resolveOrgMembership: jest.fn(async () => 501),
}));
jest.mock("../../../common/tenant/org-membership", () => ({
  assertUsersInOrg: jest.fn(),
}));
jest.mock("../chat-channel-member-state", () => ({
  channelHighWaterMark: jest.fn(() => 0),
}));

const ORG = "org-1";
const CHANNEL = 7;
const TARGET = "user-invited";
const REQUESTER = "user-admin";

function makeDb(alreadyMember: boolean): Db {
  return {
    query: {
      chatChannelMembers: {
        findFirst: jest.fn(async () => (alreadyMember ? { id: 1 } : undefined)),
      },
    },
    insert: jest.fn(() => ({ values: jest.fn(async () => undefined) })),
  } as unknown as Db;
}

function makeSvc(alreadyMember: boolean) {
  const notifications = { publishChannelInviteNotification: jest.fn(async () => undefined) };
  const svc = new ChatChannelMembersImplementation(
    makeDb(alreadyMember),
    {} as EntityReferenceService,
    undefined,
    notifications as unknown as ChatNotificationsService,
  );
  return { svc, notifications };
}

describe("adding someone to a channel notifies them, because chat.channel.invited had no emitter", () => {
  it("emits the invite notification to the added user after the membership row is written", async () => {
    const { svc, notifications } = makeSvc(false);

    await svc.addMember(CHANNEL, TARGET, REQUESTER, ORG);

    expect(notifications.publishChannelInviteNotification).toHaveBeenCalledWith(
      ORG,
      CHANNEL,
      TARGET,
      REQUESTER,
    );
  });

  it("does not notify when the user is already a member, so a repeated add cannot spam them", async () => {
    const { svc, notifications } = makeSvc(true);

    await expect(svc.addMember(CHANNEL, TARGET, REQUESTER, ORG)).rejects.toThrow();
    expect(notifications.publishChannelInviteNotification).not.toHaveBeenCalled();
  });

  it("keeps chat.channel.invited in the catalog, so the emitter cannot point at an unregistered key", () => {
    const keys = CHAT_NOTIFICATION_EVENTS.map((event) => event.eventKey);
    expect(keys).toContain("chat.channel.invited");
  });

  it("wires ChatNotificationsService into the chat module, so the optional dependency cannot silently go uninjected", () => {
    const providers = Reflect.getMetadata("providers", ChatModule) as unknown[];
    expect(providers).toContain(ChatNotificationsService);
    expect(providers).toContain(ChatChannelMembersImplementation);
  });
});
