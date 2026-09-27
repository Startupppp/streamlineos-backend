import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.module";
import type { AccessService } from "../access/access.service";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../common/auth/principal";
import type { ProjectsTicketsCreateService } from "../build/core/tickets/projects-tickets-create.service";

jest.mock("../build/core", () => ({
  assertProjectAccess: jest.fn(),
  assertProjectInOrg: jest.fn(),
}));

import { assertProjectAccess } from "../build/core";
import { FeedbucketSubmissionsService } from "./feedbucket-submissions.service";

const ORG = "org-1";
const WIDGET_PROJECT_ID = 4;
const FOREIGN_PROJECT_ID = 77;
const SUBMISSION_ID = 12;

const assertProjectAccessMock = assertProjectAccess as jest.MockedFunction<
  typeof assertProjectAccess
>;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(7, false),
  };
}

function makeDb() {
  const findFirst = jest.fn().mockResolvedValue({
    id: SUBMISSION_ID,
    orgId: ORG,
    type: "bug",
    message: "the export button does nothing",
    widget: {
      id: 1,
      projectId: WIDGET_PROJECT_ID,
      defaultProjectId: null,
      defaultTicketType: "BUG",
      assigneeRules: null,
      defaultAssigneeMembershipId: null,
    },
    linkedTicket: null,
  });
  const attachmentsLimit = jest.fn().mockResolvedValue([]);
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const db = {
    query: { feedbucketSubmissions: { findFirst } },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: attachmentsLimit }),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({ where: updateWhere }),
    }),
  } as unknown as Db;
  return { db, updateWhere };
}

function makeService(db: Db) {
  const storage = { deleteFileIfPresent: jest.fn() };
  const access = {} as AccessService;
  return new FeedbucketSubmissionsService(db, storage, access);
}

function makeTicketsService() {
  const createFromFeedback = jest.fn().mockResolvedValue({ id: 900 });
  return {
    service: { createFromFeedback } as unknown as ProjectsTicketsCreateService,
    createFromFeedback,
  };
}

beforeEach(() => {
  assertProjectAccessMock.mockReset();
  assertProjectAccessMock.mockResolvedValue(undefined);
});

describe("feedbucket convert-to-ticket gates on project membership, not merely on the project being in the org", () => {
  it("refuses a caller-supplied projectId they are not a member of, because the override wins over the widget's own project", async () => {
    const { db, updateWhere } = makeDb();
    const { service: tickets, createFromFeedback } = makeTicketsService();
    assertProjectAccessMock.mockRejectedValue(
      new ForbiddenException("You do not have access to this project"),
    );

    await expect(
      makeService(db).convertToTicket(makeU(), SUBMISSION_ID, tickets, {
        projectId: FOREIGN_PROJECT_ID,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(createFromFeedback).not.toHaveBeenCalled();
    expect(updateWhere).not.toHaveBeenCalled();
  });

  it("asserts access against the resolved projectId rather than the raw override, so the widget-derived path is covered too", async () => {
    const { db } = makeDb();
    const { service: tickets } = makeTicketsService();

    await makeService(db).convertToTicket(makeU(), SUBMISSION_ID, tickets);

    expect(assertProjectAccessMock).toHaveBeenCalledTimes(1);
    expect(assertProjectAccessMock.mock.calls[0]?.[3]).toBe(WIDGET_PROJECT_ID);
  });

  it("passes the override projectId to the access assertion when one is supplied", async () => {
    const { db } = makeDb();
    const { service: tickets } = makeTicketsService();

    await makeService(db).convertToTicket(makeU(), SUBMISSION_ID, tickets, {
      projectId: FOREIGN_PROJECT_ID,
    });

    expect(assertProjectAccessMock.mock.calls[0]?.[3]).toBe(FOREIGN_PROJECT_ID);
  });

  it("still converts for a member, so the gate narrows the callers rather than breaking the feature", async () => {
    const { db, updateWhere } = makeDb();
    const { service: tickets, createFromFeedback } = makeTicketsService();

    const result = await makeService(db).convertToTicket(
      makeU(),
      SUBMISSION_ID,
      tickets,
      { projectId: FOREIGN_PROJECT_ID },
    );

    expect(result).toEqual({ ticketId: 900 });
    expect(createFromFeedback).toHaveBeenCalledTimes(1);
    expect(createFromFeedback.mock.calls[0]?.[2]).toBe(FOREIGN_PROJECT_ID);
    expect(updateWhere).toHaveBeenCalledTimes(1);
  });

  it("carries the acting user id from the context rather than a separately passed argument the client could influence", async () => {
    const { db } = makeDb();
    const { service: tickets, createFromFeedback } = makeTicketsService();

    await makeService(db).convertToTicket(makeU(), SUBMISSION_ID, tickets);

    expect(createFromFeedback.mock.calls[0]?.[0]).toBe(ORG);
    expect(createFromFeedback.mock.calls[0]?.[1]).toBe("user-7");
  });
});
