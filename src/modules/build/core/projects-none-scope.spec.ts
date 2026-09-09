import { Test } from "@nestjs/testing";
import { ProjectsQueryService } from "./projects-query.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";

it("none project scope does not fall back to membership visibility", async () => {
  const select = jest.fn(() => { throw new Error("none scope queried memberships"); });
  const module = await Test.createTestingModule({ providers: [ProjectsQueryService,
    { provide: DRIZZLE, useValue: { select } },
    { provide: AuditService, useValue: {} },
    { provide: AccessService, useValue: { scopeFor: async () => "none" } },
  ] }).compile();
  const actor: CurrentUserContext = { orgId: "org-a", userId: "member", role: "MEMBER", isOrgOwner: false,
    sessionId: "session", tokenScopes: null, principal: { kind: "human-session", membershipId: 12, isOrgOwner: false } };
  await expect(module.get(ProjectsQueryService).listProjects(actor, { status: "ALL", limit: 20 }))
    .resolves.toEqual({ data: [], hasMore: false, nextCursor: null });
  expect(select).not.toHaveBeenCalled();
  await module.close();
});
