import { BadRequestException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { FeedbucketWidgetsService } from "../feedbucket-widgets.service";

const ORG = "org_1";

function makeDb(memberships: { userId: string; membershipId: number }[]) {
  const membershipRows = memberships.map((m) => ({ id: m.membershipId, userId: m.userId }));
  const peopleRows = memberships.map((m) => ({
    membershipId: m.membershipId,
    organizationPersonId: m.membershipId,
  }));
  let selectCall = 0;
  const select = jest.fn().mockImplementation(() => ({
    from: jest.fn().mockReturnValue({
      where: jest.fn().mockImplementation(() => {
        selectCall += 1;
        return Promise.resolve(selectCall === 1 ? membershipRows : peopleRows);
      }),
    }),
  }));
  const insertResult = { id: 1 };
  const insert = jest.fn().mockReturnValue({
    values: jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([insertResult]),
    }),
  });
  return {
    select,
    insert,
    query: {
      feedbucketWidgets: {
        findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG, deletedAt: null }),
      },
    },
  } as unknown as Db;
}

describe("FeedbucketWidgetsService — assignee resolution", () => {
  it("rejects a defaultAssigneeId that is not an active member of this org", async () => {
    const db = makeDb([]);
    const service = new FeedbucketWidgetsService(db);

    await expect(
      service.create(ORG, "creator_1", {
        name: "Widget",
        defaultAssigneeId: "not_a_member",
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("resolves each assigneeRules entry to its own membershipId, independent of the default assignee", async () => {
    const db = makeDb([
      { userId: "user_bug", membershipId: 11 },
      { userId: "user_feature", membershipId: 22 },
    ]);
    const service = new FeedbucketWidgetsService(db);

    await service.create(ORG, "creator_1", {
      name: "Widget",
      assigneeRules: { bug: "user_bug", feature: "user_feature" },
    });

    const insertValues = (db.insert as jest.Mock).mock.results[0].value.values as jest.Mock;
    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        assigneeRules: { bug: 11, feature: 22 },
      }),
    );
  });
});
