import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { AccessService } from "../../access/access.service";
import { humanSessionPrincipal, systemJobPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { assertProjectInOrg, resolveProjectAccess } from "./project-access";
import { assertProjectAggregateAccess } from "./build-project-aggregate-access";

jest.mock("./project-access", () => ({ resolveProjectAccess: jest.fn(), assertProjectInOrg: jest.fn() }));
const projectAccess = jest.mocked(resolveProjectAccess);
const actor: CurrentUserContext = {
  orgId: "org", userId: "member", role: "MEMBER", isOrgOwner: false,
  sessionId: "session", tokenScopes: null, principal: humanSessionPrincipal(1, false),
};

describe("project aggregate access", () => {
  beforeEach(() => jest.resetAllMocks());

  it.each(["own", "team", "none"])("denies %s ticket scope before a shared report cache can be read", async (scope) => {
    projectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue(scope) } },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), actor, 10)).rejects.toThrow(ForbiddenException);
    } finally { await module.close(); }
  });

  it("allows an authorized project member with all-ticket scope", async () => {
    projectAccess.mockResolvedValue({ hasAccess: true, role: "MEMBER" });
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: { scopeFor: jest.fn().mockResolvedValue("all") } },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), actor, 10)).resolves.toBeUndefined();
    } finally { await module.close(); }
  });

  it("preserves404 for foreign projects and does not query ticket scope", async () => {
    projectAccess.mockRejectedValue(new NotFoundException("Project not found"));
    const scopeFor = jest.fn();
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: { scopeFor } },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), actor, 99)).rejects.toThrow(NotFoundException);
      expect(scopeFor).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it("denies a same-tenant project nonmember even with all-ticket scope", async () => {
    projectAccess.mockResolvedValue({ hasAccess: false, role: null });
    const scopeFor = jest.fn().mockResolvedValue("all");
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: { scopeFor } },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), actor, 10)).rejects.toThrow(ForbiddenException);
      expect(scopeFor).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it("allows the registered snapshot job only after checking its tenant project", async () => {
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: {} },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), {
        ...actor, principal: systemJobPrincipal("build.daily-snapshots"),
      }, 10)).resolves.toBeUndefined();
      expect(assertProjectInOrg).toHaveBeenCalledWith(module.get(DRIZZLE), actor.orgId, 10);
      expect(projectAccess).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it("refuses a job whose capability ceiling excludes project aggregates", async () => {
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: {} },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), {
        ...actor, principal: systemJobPrincipal("integrations.git.webhook"),
      }, 10)).rejects.toThrow(ForbiddenException);
      expect(assertProjectInOrg).not.toHaveBeenCalled();
    } finally { await module.close(); }
  });

  it("preserves foreign-project404 for the authorized snapshot job", async () => {
    jest.mocked(assertProjectInOrg).mockRejectedValue(new NotFoundException("Project not found"));
    const module = await Test.createTestingModule({ providers: [
      { provide: DRIZZLE, useValue: {} }, { provide: AccessService, useValue: {} },
    ] }).compile();
    try {
      await expect(assertProjectAggregateAccess(module.get<Db>(DRIZZLE), module.get(AccessService), {
        ...actor, principal: systemJobPrincipal("build.daily-snapshots"),
      }, 99)).rejects.toThrow(NotFoundException);
    } finally { await module.close(); }
  });
});
