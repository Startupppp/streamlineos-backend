import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import { hrMoodCheckins } from "../../../db/schema/hr/engagement-extras";
import { EngagementMoodPollsService } from "./engagement-mood-polls.service";

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(11, false),
};

describe("EngagementMoodPollsService", () => {
  it("upserts a member's daily mood against the existing membership uniqueness constraint", async () => {
    const returning = jest.fn().mockResolvedValue([{ id: 1 }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const db = { insert: jest.fn().mockReturnValue({ values }) } as unknown as Db;
    const service = new EngagementMoodPollsService(db);

    await service.moodCheckin(actor, { date: "2026-09-01", mood: 4, note: "Focused" });

    expect(onConflictDoUpdate).toHaveBeenCalledWith(expect.objectContaining({
      target: [hrMoodCheckins.orgId, hrMoodCheckins.userMembershipId, hrMoodCheckins.date],
      set: expect.objectContaining({ userMembershipId: 11 }),
    }));
  });
});
