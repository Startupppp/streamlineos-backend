import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { AccessService } from "../../../access/access.service";
import { MANAGER_STANDING, standingAccess, type StandingScopes } from "../../core/project-crud/__tests__/project-access-doubles";
import { PortfoliosService } from "../portfolios.service";
import { ProgramsService } from "../programs.service";

export function actorIn(orgId: string, userId = "user-1", membershipId = 1): CurrentUserContext {
  return {
    orgId,
    userId,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

async function compileServices(db: unknown, audit: unknown, standing: StandingScopes) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PortfoliosService,
      ProgramsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: audit },
      { provide: AccessService, useValue: standingAccess(standing) },
    ],
  }).compile();
  return moduleRef;
}

export async function portfoliosService(
  db: unknown,
  audit: unknown = { log: jest.fn() },
  standing: StandingScopes = MANAGER_STANDING,
): Promise<PortfoliosService> {
  return (await compileServices(db, audit, standing)).get(PortfoliosService);
}

export async function programsService(
  db: unknown,
  audit: unknown = { log: jest.fn() },
  standing: StandingScopes = MANAGER_STANDING,
): Promise<ProgramsService> {
  return (await compileServices(db, audit, standing)).get(ProgramsService);
}
