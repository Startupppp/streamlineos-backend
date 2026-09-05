import { chatOrgSettingsResponseSchema } from "./chat-org-settings-response.schema";

describe("chat org settings response contract", () => {
  it("accepts the effective settings projection", () => {
    expect(
      chatOrgSettingsResponseSchema.safeParse({
        orgId: "org-1",
        defaultNotificationPreference: "MENTIONS",
        maxAttachmentSizeMb: 25,
        maxHuddleParticipants: 50,
      }).success,
    ).toBe(true);
  });

  it("rejects persistence-only fields", () => {
    expect(
      chatOrgSettingsResponseSchema.safeParse({
        orgId: "org-1",
        defaultNotificationPreference: "ALL",
        maxAttachmentSizeMb: 25,
        maxHuddleParticipants: 50,
        updatedByMembershipId: 4,
      }).success,
    ).toBe(false);
  });
});
