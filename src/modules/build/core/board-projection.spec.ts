import { ProjectsTicketsReadService } from "./projects-tickets-read.service";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import type { Db } from "../../../db/drizzle.module";
import type { DataScope } from "../../access/access.types";
import { TICKETS_PERMISSION } from "./tickets-scope";

const ORG_ID = "org-board-proj";

const makeUser = (overrides: Partial<CurrentUserContext> = {}): CurrentUserContext => ({
  userId: "user-1",
  orgId: ORG_ID,
  role: "EMPLOYEE",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: humanSessionPrincipal(1, true),
  ...overrides,
});

describe("board list projection", () => {
  it("description is absent from TICKET_LIST_COLUMNS — re-adding it fails this test", async () => {
    let capturedColumns: Record<string, boolean> | undefined;

    const db = {
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                offset: jest.fn().mockResolvedValue([{ total: "0" }]),
              }),
            }),
          }),
        }),
      }),
      execute: jest.fn().mockResolvedValue([]),
      query: {
        projects: {
          findFirst: jest.fn().mockResolvedValue({ id: 1, orgId: ORG_ID }),
        },
        tickets: {
          findMany: jest.fn().mockImplementation(({ columns }: { columns: Record<string, boolean> }) => {
            capturedColumns = columns;
            return Promise.resolve([]);
          }),
        },
      },
    } as unknown as Db;

    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(
        new Map<string, DataScope>([[TICKETS_PERMISSION, "all"]]),
      ),
      scopeFor: jest.fn().mockResolvedValue("all"),
    } as unknown as AccessService;

    const svc = new ProjectsTicketsReadService(db, access);

    await svc.listTickets(makeUser(), 1, {
      page: 1,
      limit: 50,
      orderBy: "rank",
    } as never);

    expect(capturedColumns).toBeDefined();
    expect((capturedColumns as Record<string, boolean>)["description"]).toBeUndefined();
  });
});
