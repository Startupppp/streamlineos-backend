import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ProjectsRetentionSettingsService } from "./projects-retention-settings.service";
import { setLegalHoldSchema, updateRetentionPolicySchema } from "../dto/project-retention-settings.schemas";

const PROJECT_ID = 7;
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

type Standing = { project: { managerMembershipId: number } | undefined; memberRole: string | null };

const MANAGER: Standing = { project: { managerMembershipId: CALLER_MEMBERSHIP }, memberRole: null };
const PLAIN_MEMBER: Standing = { project: { managerMembershipId: 999 }, memberRole: "MEMBER" };
const NON_MEMBER: Standing = { project: { managerMembershipId: 999 }, memberRole: null };
const FOREIGN: Standing = { project: undefined, memberRole: null };

const SAVED_ROW = {
  inheritOrgPolicy: false,
  closedTicketRetentionDays: 90,
  attachmentRetentionDays: null,
  auditLogRetentionDays: null,
  legalHold: false,
  legalHoldReason: null,
  legalHoldSetAt: null,
  version: 1,
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
};

function chainResolving(rows: unknown[]) {
  const chain = { from: jest.fn(), innerJoin: jest.fn(), where: jest.fn(), limit: jest.fn().mockResolvedValue(rows) };
  chain.from.mockReturnValue(chain);
  chain.innerJoin.mockReturnValue(chain);
  chain.where.mockReturnValue(chain);
  return chain;
}

async function build(standing: Standing) {
  const membershipChain = chainResolving(standing.memberRole === null ? [] : [{ role: standing.memberRole }]);
  const emptyChain = chainResolving([]);
  const select = jest.fn((projection: Record<string, unknown>) =>
    "role" in projection ? membershipChain : emptyChain,
  );
  const returning = jest.fn().mockResolvedValue([SAVED_ROW]);
  const values = jest.fn(() => ({ returning }));
  const insert = jest.fn(() => ({ values }));
  const update = jest.fn();
  const db = {
    query: { projects: { findFirst: jest.fn().mockResolvedValue(standing.project) } },
    select,
    insert,
    update,
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsRetentionSettingsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } },
    ],
  }).compile();
  return { service: moduleRef.get(ProjectsRetentionSettingsService), insert, update };
}

const POLICY = updateRetentionPolicySchema.parse({
  inheritOrgPolicy: false,
  closedTicketRetentionDays: 90,
  attachmentRetentionDays: null,
  auditLogRetentionDays: null,
});

const WRITES: Array<[string, (service: ProjectsRetentionSettingsService) => Promise<unknown>]> = [
  ["PATCH /build/:projectId/settings/retention", (service) => service.updatePolicy(caller, PROJECT_ID, POLICY)],
  [
    "PATCH /build/:projectId/settings/retention/legal-hold",
    (service) => service.setLegalHold(caller, PROJECT_ID, setLegalHoldSchema.parse({ active: true, reason: "litigation" })),
  ],
];

describe("retention policy and legal hold require manage standing on the project", () => {
  it.each(WRITES)("%s answers 403 to a project member who does not manage the project, without writing", async (_route, call) => {
    const { service, insert, update } = await build(PLAIN_MEMBER);
    await expect(call(service)).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s answers 403 to a same-org caller who is not on the project, without writing", async (_route, call) => {
    const { service, insert, update } = await build(NON_MEMBER);
    await expect(call(service)).rejects.toThrow(ForbiddenException);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s answers 404 for a project outside the caller's tenant, without writing", async (_route, call) => {
    const { service, insert, update } = await build(FOREIGN);
    await expect(call(service)).rejects.toThrow(NotFoundException);
    expect(insert).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each(WRITES)("%s writes the settings row for the project's manager", async (_route, call) => {
    const { service, insert } = await build(MANAGER);
    await call(service);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("GET /build/:projectId/settings/retention conceals a project the caller cannot see", () => {
  it("answers 404 to a same-org caller who is not on the project", async () => {
    const { service } = await build(NON_MEMBER);
    await expect(service.getSettings(caller, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("answers 404 for a project outside the caller's tenant", async () => {
    const { service } = await build(FOREIGN);
    await expect(service.getSettings(caller, PROJECT_ID)).rejects.toThrow(NotFoundException);
  });

  it("returns the inherited default to a plain project member", async () => {
    const { service } = await build(PLAIN_MEMBER);
    await expect(service.getSettings(caller, PROJECT_ID)).resolves.toMatchObject({
      projectId: PROJECT_ID,
      inheritOrgPolicy: true,
      version: 0,
    });
  });
});
