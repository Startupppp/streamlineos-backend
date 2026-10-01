import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AgentPulseService } from "./agent-pulse.service";

const PROJECT_ID = 7;
const TICKET_ID = 55;
const DRAFT_ID = 9;
const CALLER_MEMBERSHIP = 21;

const caller: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(CALLER_MEMBERSHIP, false),
};

type Standing = "member" | "non-member" | "foreign";

function rowsFor(standing: Standing, projection: Record<string, unknown>): unknown[] {
  if ("body" in projection) return [{ id: DRAFT_ID, ticketId: TICKET_ID, body: "Ship the fix" }];
  if (standing === "foreign") return [];
  if ("allowed" in projection) return [{ id: TICKET_ID, allowed: true }];
  if ("projectId" in projection) return [{ id: TICKET_ID, projectId: PROJECT_ID }];
  return [];
}

async function build(standing: Standing) {
  const select = jest.fn((projection: Record<string, unknown>) => {
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue(rowsFor(standing, projection)),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    return chain;
  });
  const returning = jest.fn().mockResolvedValue([{ id: 101 }]);
  const tx = {
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning })) })),
    delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  };
  const transaction = jest.fn(async (work: (handle: typeof tx) => Promise<unknown>) => work(tx));
  const db = {
    query: {
      projects: {
        findFirst: jest.fn().mockResolvedValue({
          managerMembershipId: standing === "member" ? CALLER_MEMBERSHIP : 999,
        }),
      },
    },
    select,
    transaction,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AgentPulseService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: AccessService,
        useValue: {
          resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
          scopeFor: jest.fn().mockResolvedValue("all"),
        },
      },
    ],
  }).compile();
  return { service: moduleRef.get(AgentPulseService), transaction };
}

describe("POST /build/agent-pulse/proposals/:draftId/apply requires access to the draft's ticket", () => {
  it("answers 403 to a same-org caller who cannot reach the ticket's project, without posting the comment", async () => {
    const { service, transaction } = await build("non-member");
    await expect(service.applyDraft(caller, DRAFT_ID)).rejects.toThrow(ForbiddenException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("answers 404 when the draft's ticket is outside the caller's tenant, without posting the comment", async () => {
    const { service, transaction } = await build("foreign");
    await expect(service.applyDraft(caller, DRAFT_ID)).rejects.toThrow(NotFoundException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("posts the comment for a caller who can reach the ticket", async () => {
    const { service, transaction } = await build("member");
    await expect(service.applyDraft(caller, DRAFT_ID)).resolves.toEqual({ commentId: 101, ticketId: TICKET_ID });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
