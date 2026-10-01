import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { AccessService } from "../../../access/access.service";
import { MANAGER_STANDING, standingAccess, type StandingScopes } from "../../core/project-crud/__tests__/project-access-doubles";
import { ManagedProductsService } from "../managed-products.service";

export function productActorIn(orgId: string, membershipId = 1): CurrentUserContext {
  return {
    orgId,
    userId: "user-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session",
    tokenScopes: null,
    principal: humanSessionPrincipal(membershipId, false),
  };
}

export const productAccessProvider = (standing: StandingScopes = MANAGER_STANDING) => ({
  provide: AccessService,
  useValue: standingAccess(standing),
});

export async function managedProductsService(
  db: unknown,
  audit: unknown = { log: jest.fn() },
  standing: StandingScopes = MANAGER_STANDING,
): Promise<ManagedProductsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ManagedProductsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: audit },
      productAccessProvider(standing),
    ],
  }).compile();
  return moduleRef.get(ManagedProductsService);
}
