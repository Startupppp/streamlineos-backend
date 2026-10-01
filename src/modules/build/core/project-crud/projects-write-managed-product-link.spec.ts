import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AuditService } from "../../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { AccessService } from "../../../access/access.service";
import { MEMBER_STANDING, projectAccessRow, standingAccess, type ProjectAccessRow } from "./__tests__/project-access-doubles";
import { ProjectsQueryService } from "./projects-query.service";
import { ProjectsWriteService } from "./projects-write.service";

const ORG = "org-1";

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "user-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

function linkDb(project: ProjectAccessRow | null) {
  const projectChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => (project === null ? [] : [project])),
  };
  const productChain = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn(async () => [{ managedProductId: 3 }]),
  };
  const returning = jest.fn(async () => [{ id: 5, orgId: ORG, name: "P", key: "P", managedProductId: 3 }]);
  return {
    select: jest.fn((fields?: Record<string, unknown>) =>
      fields !== undefined && "manages" in fields ? projectChain : productChain,
    ),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => ({ returning })) })) })),
  };
}

async function writeService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsWriteService,
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
      { provide: ProjectsQueryService, useValue: {} },
    ],
  }).compile();
  return moduleRef.get(ProjectsWriteService);
}

describe("ProjectsWriteService.linkProjectToManagedProduct — requires manage on the project", () => {
  it("refuses a caller who is only a member of the project with 403, updating nothing", async () => {
    const db = linkDb(projectAccessRow({ memberRole: "MEMBER" }));
    const svc = await writeService(db);

    await expect(svc.linkProjectToManagedProduct(actor, 5, { managedProductId: 3 })).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("refuses a project outside the caller's org with 404, updating nothing", async () => {
    const db = linkDb(null);
    const svc = await writeService(db);

    await expect(svc.linkProjectToManagedProduct(actor, 99, { managedProductId: 3 })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("links the managed product when the caller manages the project", async () => {
    const db = linkDb(projectAccessRow({ manages: true }));
    const svc = await writeService(db);

    await expect(svc.linkProjectToManagedProduct(actor, 5, { managedProductId: 3 })).resolves.toMatchObject({ id: 5, managedProductId: 3 });
    expect(db.update).toHaveBeenCalledTimes(1);
  });
});
