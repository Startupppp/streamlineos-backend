import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { WorkloadCapacityService } from "./workload-capacity.service";
import { MEMBER_STANDING, principalAccess, projectAccessRow } from "../core/project-crud/__tests__/project-access-doubles";

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

type Standing = "member" | "non-member" | "foreign";

async function build(standing: Standing) {
  const capacityReads: Record<string, unknown>[] = [];
  const projectRows = standing === "foreign" ? [] : [projectAccessRow({ manages: standing === "member" })];
  const select = jest.fn((projection: Record<string, unknown>) => {
    if ("expectedDailyHours" in projection || "userId" in projection) capacityReads.push(projection);
    const chain = {
      from: jest.fn(),
      innerJoin: jest.fn(),
      where: jest.fn(),
      limit: jest.fn().mockResolvedValue("onTeam" in projection ? projectRows : []),
    };
    chain.from.mockReturnValue(chain);
    chain.innerJoin.mockReturnValue(chain);
    chain.where.mockReturnValue(chain);
    return chain;
  });
  const moduleRef = await Test.createTestingModule({
    providers: [
      WorkloadCapacityService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: AccessService, useValue: principalAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { service: moduleRef.get(WorkloadCapacityService), capacityReads };
}

describe("GET /build/:projectId/workload/capacity only reports on a project the caller can reach", () => {
  it("answers 404 to a same-org caller who is not on the project, before reading capacity", async () => {
    const { service, capacityReads } = await build("non-member");
    await expect(service.capacity(caller, PROJECT_ID, "2026-10-01", "2026-10-14")).rejects.toThrow(NotFoundException);
    expect(capacityReads).toHaveLength(0);
  });

  it("answers 404 for a project outside the caller's tenant, before reading capacity", async () => {
    const { service, capacityReads } = await build("foreign");
    await expect(service.capacity(caller, PROJECT_ID, "2026-10-01", "2026-10-14")).rejects.toThrow(NotFoundException);
    expect(capacityReads).toHaveLength(0);
  });

  it("reports capacity to the project's manager", async () => {
    const { service, capacityReads } = await build("member");
    await expect(service.capacity(caller, PROJECT_ID, "2026-10-01", "2026-10-14")).resolves.toEqual({ members: [] });
    expect(capacityReads.length).toBeGreaterThan(0);
  });
});
