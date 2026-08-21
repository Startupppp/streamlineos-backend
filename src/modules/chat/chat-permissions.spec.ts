import "reflect-metadata";
import { ChatChannelsController } from "./chat-channels.controller";
import { ChatHuddlesController } from "./chat-huddles.controller";
import { ChatInviteLinksController } from "./chat-invite-links.controller";
import { ChatPinsController } from "./chat-pins.controller";
import { ChatOrgSettingsController } from "./chat-org-settings.controller";
import { REQUIRE_PERMISSION } from "../access/require-permission.decorator";
import { PERMISSIONS } from "../rbac/permissions";

describe("Chat new permission keys — every key gates a real route", () => {
  it("leaves POST /chat/channels on the broad write key, because it also opens direct messages", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatChannelsController.prototype.create),
    ).toBe("chat:channels:write");
  });

  it("chat:huddles:start gates POST /chat/channels/:channelId/huddle/start", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatHuddlesController.prototype.startHuddle),
    ).toBe("chat:huddles:start");
  });

  it("chat:huddles:moderate gates POST /chat/huddles/:huddleId/kick", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatHuddlesController.prototype.kickParticipant),
    ).toBe("chat:huddles:moderate");
  });

  it("chat:invite-links:manage gates POST /chat/channels/:channelId/invite-link", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatInviteLinksController.prototype.getOrCreate),
    ).toBe("chat:invite-links:manage");
  });

  it("chat:invite-links:manage gates POST /chat/channels/:channelId/invite-link/regenerate", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatInviteLinksController.prototype.regenerate),
    ).toBe("chat:invite-links:manage");
  });

  it("chat:messages:pin gates POST /chat/channels/:channelId/pins", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatPinsController.prototype.pin),
    ).toBe("chat:messages:pin");
  });

  it("chat:messages:pin gates DELETE /chat/channels/:channelId/pins/:messageId", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatPinsController.prototype.unpin),
    ).toBe("chat:messages:pin");
  });

  it("chat:org-settings:manage gates PATCH /chat/settings", () => {
    expect(
      Reflect.getMetadata(REQUIRE_PERMISSION, ChatOrgSettingsController.prototype.update),
    ).toBe("chat:org-settings:manage");
  });
});

describe("the new keys are in the catalog, not just on a route", () => {
  const catalogNames = new Set(PERMISSIONS.map((permission) => permission.name));

  it.each([
    "chat:messages:pin",
    "chat:huddles:start",
    "chat:huddles:moderate",
    "chat:invite-links:manage",
    "chat:org-settings:manage",
    "calendar:events:export",
  ])("%s is grantable", (key) => {
    expect(catalogNames.has(key)).toBe(true);
  });
});
