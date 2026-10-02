import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketLinksService } from "./projects-ticket-links.service";
import { standingAccess } from "../../__tests__/project-access-doubles";

type Chain = Record<string, unknown>;

function chain(result: unknown[]): Chain {
  const node: Chain = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "for"])
    node[method] = () => node;
  node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
  return node;
}

const ORG = "org-1";
const OUTSIDER_PROJECT_ID = 7;
const TICKET_ID = 4242;

function outsider(): CurrentUserContext {
  return {
    userId: "u-outsider",
    orgId: ORG,
    isOrgOwner: false,
    sessionId: "s1",
    principal: { kind: "human-session", membershipId: 11, sessionId: "s1" },
  } as unknown as CurrentUserContext;
}

function insider(): CurrentUserContext {
  return { ...outsider(), isOrgOwner: true } as CurrentUserContext;
}

function accessDouble() {
  return standingAccess({ "build:view": "own", "build:tickets:view": "all" });
}

function ticketDecisionRow(reachable: boolean) {
  return { projectId: OUTSIDER_PROJECT_ID, projectState: "ACTIVE", projectDeletedAt: null, reachable, inScope: true };
}

const leakedRow = {
  id: 1,
  orgId: ORG,
  ticketId: TICKET_ID,
  url: "https://leak.test",
  label: null,
  createdBy: "u-other",
  createdAt: new Date(),
};

function dbForOutsider(): Db {
  return {
    select: jest
      .fn()
      .mockReturnValueOnce(chain([ticketDecisionRow(false)]))
      .mockReturnValue(chain([leakedRow])),
    insert: jest.fn().mockReturnValue({
      values: () => ({ returning: () => Promise.resolve([leakedRow]) }),
    }),
  } as unknown as Db;
}

describe("ProjectsTicketLinksService — project membership gate on related links", () => {
  it("listRelatedLinks refuses an org-wide build:tickets:view holder who is not a member of the url project", async () => {
    const svc = new ProjectsTicketLinksService(dbForOutsider(), accessDouble());

    await expect(
      svc.listRelatedLinks(outsider(), OUTSIDER_PROJECT_ID, TICKET_ID),
    ).rejects.toThrow(ForbiddenException);
  });

  it("addRelatedLink refuses an org-wide build:tickets:update holder who is not a member of the url project", async () => {
    const db = dbForOutsider();
    const svc = new ProjectsTicketLinksService(db, accessDouble());

    await expect(
      svc.addRelatedLink(outsider(), OUTSIDER_PROJECT_ID, TICKET_ID, {
        url: "https://example.test",
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("listRelatedLinks still answers a caller who does have access to the url project (control)", async () => {
    const db = {
      select: jest
        .fn()
        .mockReturnValueOnce(chain([ticketDecisionRow(true)]))
        .mockReturnValue(
          chain([
            { id: 1, orgId: ORG, ticketId: TICKET_ID, url: "https://ok", label: null, createdBy: "u-outsider", createdAt: new Date() },
          ]),
        ),
    } as unknown as Db;
    const svc = new ProjectsTicketLinksService(db, accessDouble());

    const rows = await svc.listRelatedLinks(insider(), OUTSIDER_PROJECT_ID, TICKET_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.projectId).toBe(OUTSIDER_PROJECT_ID);
  });
});
