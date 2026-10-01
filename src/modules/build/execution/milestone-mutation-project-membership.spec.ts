import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { MilestonesService } from "./workspace.service";
import { lifecycleAuditDouble } from "../lifecycle/audit-double";

const ORG = "org-1";
const PROJECT_ID = 1;
const MILESTONE_ID = 10;

const actor: CurrentUserContext = {
  userId: "user-1",
  orgId: ORG,
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s1",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

const access = {
  resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
} as unknown as AccessService;

function makeDb(isProjectMember: boolean) {
  const chain: Record<string, jest.Mock> = {};
  const self = () => chain;
  chain["from"] = jest.fn(self);
  chain["innerJoin"] = jest.fn(self);
  chain["leftJoin"] = jest.fn(self);
  chain["where"] = jest.fn(self);
  chain["limit"] = jest.fn(() => Promise.resolve(isProjectMember ? [{ role: "MEMBER" }] : []));
  chain["groupBy"] = jest.fn(() => Promise.resolve([]));
  const returning = jest.fn(() => Promise.resolve([{ id: MILESTONE_ID, ownerMembershipId: null, version: 2 }]));
  const update = jest.fn(() => ({ set: () => ({ where: () => ({ returning }) }) }));
  const db = {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue({ managerMembershipId: 999 }) },
      projectMilestones: {
        findFirst: jest.fn().mockResolvedValue({ version: 1, ownerMembershipId: null, deletedAt: new Date() }),
      },
    },
    select: jest.fn(self),
    update,
  } as unknown as Db;
  return { db, update };
}

function service(db: Db) {
  return new MilestonesService(db, access, lifecycleAuditDouble());
}

const mutations: readonly [string, (svc: MilestonesService) => Promise<unknown>][] = [
  ["updateMilestone", (svc) => svc.updateMilestone(actor, PROJECT_ID, MILESTONE_ID, { name: "renamed", version: 1 })],
  ["deleteMilestone", (svc) => svc.deleteMilestone(actor, PROJECT_ID, MILESTONE_ID)],
  ["restoreMilestone", (svc) => svc.restoreMilestone(actor, PROJECT_ID, MILESTONE_ID)],
];

describe("milestone mutations require membership of the URL project, like listing them does", () => {
  it.each(mutations)("%s refuses a same-org non-member with 403 and writes nothing", async (_name, run) => {
    const { db, update } = makeDb(false);
    await expect(run(service(db))).rejects.toThrow(ForbiddenException);
    expect(update).not.toHaveBeenCalled();
  });

  it.each(mutations)("%s proceeds for a project member (paired control)", async (_name, run) => {
    const { db, update } = makeDb(true);
    await expect(run(service(db))).resolves.toBeDefined();
    expect(update).toHaveBeenCalledTimes(1);
  });
});
