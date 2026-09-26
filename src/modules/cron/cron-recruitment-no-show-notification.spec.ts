import { interviews, notifications, tasks } from "../../db/schema";
import { MembershipResolvingDispatchDouble } from "../notifications/notification-recipient-membership.spec-fixtures";
import { CronRecruitmentService } from "./cron-recruitment.service";

jest.mock("../../common/tenant", () => ({
  ...jest.requireActual("../../common/tenant"),
  forEachOrg: async (
    db: unknown,
    _sweep: string,
    fn: (tx: unknown, orgId: string) => Promise<void>,
  ) => {
    await fn(db, ORG_ID);
    return { visited: 1, succeeded: 1, transientFailures: 0, failedOrgIds: [] };
  },
}));

const ORG_ID = "org-recruitment-no-show";
const HR_ONE = "user-hr-one";
const HR_ONE_MEMBERSHIP_ID = 4401;
const HR_TWO = "user-hr-two";
const HR_TWO_MEMBERSHIP_ID = 4402;
const INTERVIEW_ID = 918;
const CANDIDATE_ID = 71;

const DUE_INTERVIEW = {
  interviewId: INTERVIEW_ID,
  orgId: ORG_ID,
  candidateId: CANDIDATE_ID,
  firstName: "Meera",
  lastName: "Rao",
  email: "meera.rao@example.test",
  orgName: "Northwind",
};

function buildService(options: { hrUserIds?: string[]; due?: Array<typeof DUE_INTERVIEW> } = {}) {
  const { hrUserIds = [HR_ONE, HR_TWO], due = [DUE_INTERVIEW] } = options;
  const insertedTables: unknown[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        innerJoin: () => ({
          innerJoin: () => ({ where: async () => (table === interviews ? due : []) }),
        }),
      }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [{ id: INTERVIEW_ID }] }) }),
    }),
    insert: (table: unknown) => {
      insertedTables.push(table);
      return { values: async () => undefined };
    },
  };
  const dispatch = new MembershipResolvingDispatchDouble([
    { userId: HR_ONE, membershipId: HR_ONE_MEMBERSHIP_ID },
    { userId: HR_TWO, membershipId: HR_TWO_MEMBERSHIP_ID },
  ]);
  const service = new CronRecruitmentService(
    db as never,
    { sendEmail: jest.fn(async () => undefined) } as never,
    {
      membersWithPermission: jest.fn(async () => hrUserIds.map((userId) => ({ userId }))),
    } as never,
    dispatch as never,
  );
  return { service, dispatch, insertedTables };
}

describe("CronRecruitmentService.processInterviewNoShows — the HR desk is told through the dispatcher", () => {
  it("addresses every hr:interviews:manage holder by membership id", async () => {
    const { service, dispatch } = buildService();

    await service.processInterviewNoShows();

    expect(dispatch.rows).toEqual([
      { orgId: ORG_ID, eventKey: "recruitment.interview.no_show", userId: HR_ONE, membershipId: HR_ONE_MEMBERSHIP_ID },
      { orgId: ORG_ID, eventKey: "recruitment.interview.no_show", userId: HR_TWO, membershipId: HR_TWO_MEMBERSHIP_ID },
    ]);
  });

  it("never inserts into notifications itself, because a hand-built row leaves membership_id null and no reader can see it", async () => {
    const { service, insertedTables } = buildService();

    await service.processInterviewNoShows();

    expect(insertedTables.filter((table) => table === notifications)).toHaveLength(0);
  });

  it("still writes the follow-up task, so routing the notice through the dispatcher did not drop the other half of the sweep", async () => {
    const { service, insertedTables } = buildService();

    await service.processInterviewNoShows();

    expect(insertedTables.filter((table) => table === tasks)).toHaveLength(1);
  });

  it("emits nothing when the organization has nobody holding hr:interviews:manage", async () => {
    const { service, dispatch } = buildService({ hrUserIds: [] });

    await service.processInterviewNoShows();

    expect(dispatch.inputs).toEqual([]);
  });
});
