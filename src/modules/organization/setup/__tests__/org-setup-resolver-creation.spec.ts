import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { OrgSetupResolverService } from "../org-setup-resolver.service";

describe("OrgSetupResolverService organization creation", () => {
  it("delegates setup creation to the shared organization saga owner", async () => {
    const creation = {
      createFromSetup: jest.fn().mockResolvedValue({
        id: "org-created",
        name: "Acme",
        slug: "acme-stable",
      }),
    };
    const audit = { log: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        OrgSetupResolverService,
        { provide: DRIZZLE, useValue: {} },
        { provide: CacheService, useValue: {} },
        { provide: AuditService, useValue: audit },
        { provide: OrganizationCreationService, useValue: creation },
      ],
    }).compile();
    const resolver = moduleRef.get(OrgSetupResolverService);
    jest.spyOn(
      resolver as unknown as {
        findSetupContext: (userId: string) => Promise<{ activeTarget: null; memberships: [] }>;
      },
      "findSetupContext",
    ).mockResolvedValue({ activeTarget: null, memberships: [] });
    const actor: CurrentUserContext = {
      userId: "user-1",
      orgId: "",
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "session-1",
      tokenScopes: null,
      principal: { kind: "account-only" },
    };

    await expect(
      resolver.resolveOrCreateOrg(
        actor,
        { companyName: "  Acme  " },
      ),
    ).resolves.toEqual({ orgId: "org-created", isOwner: true });

    expect(creation.createFromSetup).toHaveBeenCalledTimes(1);
    expect(creation.createFromSetup).toHaveBeenCalledWith({
      userId: "user-1",
      name: "Acme",
    });
    expect(audit.log).toHaveBeenCalledWith({
      action: "org.created",
      userId: "user-1",
      orgId: "org-created",
      targetId: "org-created",
      targetType: "organization",
    });
  });
});
