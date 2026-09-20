import { FeedbucketWidgetsService } from "./feedbucket-widgets.service";
import { feedbucketWidgetWithProjectSchema } from "./dto/feedbucket-response.schemas";
import { resolveOrganizationActorsByUserIds } from "../../common/organization/organization-actor";

jest.mock("../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn(),
}));

const resolveActors = resolveOrganizationActorsByUserIds as jest.MockedFunction<
  typeof resolveOrganizationActorsByUserIds
>;

const widgetRow = {
  id: 2,
  orgId: "org-1",
  projectId: 7,
  managedProductId: null,
  defaultProjectId: 7,
  defaultAssigneeMembershipId: null,
  assigneeRules: null,
  name: "Site widget",
  publicKey: "fb_key",
  allowedDomains: [],
  autoCreateTicket: false,
  defaultTicketType: "BUG",
  isActive: true,
  aiAssistEnabled: false,
  theme: null,
  createdBy: "user-1",
  createdAt: new Date("2026-09-16T00:00:00.000Z"),
  updatedAt: new Date("2026-09-16T00:00:00.000Z"),
  deletedAt: null,
};

const project = { id: 7, name: "Web", key: "WEB", orgId: "org-1" };

function buildDb(rowsUpdated: unknown[]) {
  const findFirst = jest.fn().mockResolvedValue({ ...widgetRow, project });
  const returning = jest.fn().mockResolvedValue(rowsUpdated);
  const where = jest.fn().mockReturnValue({ returning });
  const db = {
    query: { feedbucketWidgets: { findFirst } },
    update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where }) }),
  };
  return { db, findFirst, where, returning };
}

describe("FeedbucketWidgetsService.update response shape", () => {
  beforeEach(() => {
    resolveActors.mockResolvedValue(
      new Map([
        [
          "user-9",
          {
            orgId: "org-1",
            membershipId: 41,
            userId: "user-9",
            organizationPersonId: null,
            role: "MEMBER",
            isOwner: false,
            resolvedVia: "user" as const,
          },
        ],
      ]),
    );
  });

  it("returns the project relation the widget response contract requires", async () => {
    const { db } = buildDb([widgetRow]);
    const service = new FeedbucketWidgetsService(db as never);

    const updated = await service.update("org-1", 2, { assigneeRules: { bug: "user-9" } });

    const parsed = feedbucketWidgetWithProjectSchema.safeParse(updated);
    expect(parsed.error?.issues ?? []).toEqual([]);
  });

  it("does not update a soft-deleted widget", async () => {
    const { db } = buildDb([]);
    const service = new FeedbucketWidgetsService(db as never);

    await expect(service.update("org-1", 2, { name: "Renamed" })).rejects.toThrow("Widget not found");
  });
});
