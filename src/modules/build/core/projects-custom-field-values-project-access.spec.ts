import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { assertProjectAccess } from "./project-access";
import { ProjectsCustomFieldsService } from "./projects-custom-fields.service";

jest.mock("./project-access", () => ({
  assertProjectAccess: jest.fn(),
  assertProjectInOrg: jest.fn(),
}));

const ORG_ID = "org-1";
const PROJECT_ID = 7;
const TICKET_ID = 55;
const FIELD_ID = 100;
const FOREIGN_FIELD_ID = 200;

const user: CurrentUserContext = {
  userId: "user-7",
  orgId: ORG_ID,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

describe("ProjectsCustomFieldsService ticket value authorization", () => {
  const ticketFindFirst = jest.fn();
  const select = jest.fn();
  const onConflictDoUpdate = jest.fn();
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
  const insert = jest.fn().mockReturnValue({ values });
  const db = { query: { tickets: { findFirst: ticketFindFirst } }, select, insert };
  const access = { resolveUserPermissions: jest.fn() };
  let service: ProjectsCustomFieldsService;

  beforeEach(async () => {
    jest.resetAllMocks();
    jest.mocked(assertProjectAccess).mockResolvedValue(undefined);
    ticketFindFirst.mockResolvedValue({ id: TICKET_ID });
    onConflictDoUpdate.mockResolvedValue(undefined);
    values.mockReturnValue({ onConflictDoUpdate });
    insert.mockReturnValue({ values });

    const testingModule = await Test.createTestingModule({
      providers: [
        ProjectsCustomFieldsService,
        { provide: DRIZZLE, useValue: db },
        { provide: AccessService, useValue: access },
      ],
    }).compile();
    service = testingModule.get(ProjectsCustomFieldsService);
  });

  it("denies value reads before loading the ticket when project access fails", async () => {
    jest.mocked(assertProjectAccess).mockRejectedValue(new ForbiddenException());

    await expect(service.getTicketValues(user, PROJECT_ID, TICKET_ID)).rejects.toThrow(
      ForbiddenException,
    );
    expect(ticketFindFirst).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("returns values after project access succeeds", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ innerJoin });
    select.mockReturnValue({ from });

    await expect(service.getTicketValues(user, PROJECT_ID, TICKET_ID)).resolves.toEqual([]);
    expect(assertProjectAccess).toHaveBeenCalledWith(db, access, user, PROJECT_ID);
  });

  it("denies value writes before loading the ticket when project access fails", async () => {
    jest.mocked(assertProjectAccess).mockRejectedValue(new ForbiddenException());

    await expect(
      service.upsertTicketValues(user, PROJECT_ID, TICKET_ID, {
        values: [{ fieldId: FIELD_ID, value: "x" }],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(ticketFindFirst).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("rejects a field id that does not belong to the URL project", async () => {
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    select.mockReturnValue({ from });

    await expect(
      service.upsertTicketValues(user, PROJECT_ID, TICKET_ID, {
        values: [{ fieldId: FOREIGN_FIELD_ID, value: "x" }],
      }),
    ).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
  });

  it("writes values only after every field id resolves inside the URL project", async () => {
    const where = jest.fn().mockResolvedValue([{ id: FIELD_ID }]);
    const from = jest.fn().mockReturnValue({ where });
    select.mockReturnValue({ from });

    await expect(
      service.upsertTicketValues(user, PROJECT_ID, TICKET_ID, {
        values: [{ fieldId: FIELD_ID, value: "x" }],
      }),
    ).resolves.toEqual({ success: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
