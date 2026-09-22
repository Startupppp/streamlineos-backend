import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import { makeGuardCtx, MODULE_AVAILABLE, MODULE_DISABLED, testActor } from "../../../../test/helpers/module-guard-context";
import { JwtAuthGuard } from "../../../common/auth/jwt-auth.guard";
import { ModuleGuard } from "../../../common/rbac/module.guard";
import { REQUIRE_MODULE } from "../../../common/rbac/require-module.decorator";
import { IDEMPOTENCY_COMMAND } from "../../../common/idempotency/idempotency.constants";
import { AccessService } from "../../access/access.service";
import { PermissionGuard } from "../../access/permission.guard";
import { REQUIRE_PERMISSION } from "../../access/require-permission.decorator";
import { ROLE_DEFAULT_PERMISSIONS } from "../../rbac/permissions/role-defaults";
import { EmployeeSupportController } from "./employee-support.controller";
import { HrHelpdeskController } from "./hr-helpdesk.controller";
import { HrHelpdeskService } from "./hr-helpdesk.service";
import { HrHelpdeskConfigService } from "./hr-helpdesk-config.service";
import { resolveSupportActor } from "./support-actor";

type Handler = (...args: never[]) => unknown;

function gateOf(handler: Handler): unknown {
  return Reflect.getMetadata(REQUIRE_PERMISSION, handler);
}

async function guardHolding(keys: readonly string[]): Promise<PermissionGuard> {
  const held = new Set(keys);
  const module = await Test.createTestingModule({
    providers: [
      PermissionGuard,
      Reflector,
      {
        provide: AccessService,
        useValue: {
          scopeFor: async (_user: unknown, key: string) => (held.has(key) ? "all" : "none"),
          getModuleState: async () => true,
        },
      },
    ],
  }).compile();
  return module.get(PermissionGuard);
}

const member = { orgId: "org-1", userId: "u-1", isOrgOwner: false };
const passThrough = { canActivate: () => true };

describe("EmployeeSupportController — the employee's own requests under /me/support", () => {
  const employee = EmployeeSupportController.prototype;

  it("every handler is gated on self:support and nothing else", () => {
    expect(gateOf(employee.list)).toBe("self:support");
    expect(gateOf(employee.suggest)).toBe("self:support");
    expect(gateOf(employee.getById)).toBe("self:support");
    expect(gateOf(employee.create)).toBe("self:support");
    expect(gateOf(employee.addComment)).toBe("self:support");
  });

  it("self:support is a member default, so every active employee can raise a request", () => {
    expect(ROLE_DEFAULT_PERMISSIONS["MEMBER"]).toContain("self:support");
  });

  it("carries no module gate: self-service is platform core, never a paid entitlement", () => {
    expect(new Reflector().get(REQUIRE_MODULE, EmployeeSupportController)).toBeUndefined();
  });

  it("the create route is fenced by the idempotency interceptor", () => {
    expect(Reflect.getMetadata(IDEMPOTENCY_COMMAND, employee.create)).toBe("self.support.request.create");
  });

  it("the guard admits a holder of self:support and refuses everybody else", async () => {
    await expect(
      (await guardHolding(["self:support"])).canActivate(
        makeGuardCtx(EmployeeSupportController, "create", member, MODULE_AVAILABLE),
      ),
    ).resolves.toBe(true);
    await expect(
      (await guardHolding(["hr:helpdesk:view"])).canActivate(
        makeGuardCtx(EmployeeSupportController, "create", member, MODULE_AVAILABLE),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("stays reachable when the HR module is disabled for the organisation", async () => {
    await expect(
      new ModuleGuard(new Reflector()).canActivate(
        makeGuardCtx(EmployeeSupportController, "list", member, MODULE_DISABLED),
      ),
    ).resolves.toBe(true);
    await expect(
      new ModuleGuard(new Reflector()).canActivate(
        makeGuardCtx(HrHelpdeskController, "list", member, MODULE_DISABLED),
      ),
    ).rejects.toThrow();
  });

  it("derives the subject from the token and never from the request", async () => {
    const helpdesk = {
      listMine: jest.fn().mockResolvedValue({ data: [], pagination: { limit: 20, hasMore: false, nextCursor: null } }),
      getMine: jest.fn().mockRejectedValue(new NotFoundException("Ticket not found.")),
    };
    const module = await Test.createTestingModule({
      controllers: [EmployeeSupportController],
      providers: [{ provide: HrHelpdeskService, useValue: helpdesk }],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(passThrough)
      .overrideGuard(PermissionGuard)
      .useValue(passThrough)
      .compile();
    const controller = module.get(EmployeeSupportController);
    const actor = testActor({ orgId: "org-1", userId: "u-1" });

    await controller.list({ limit: 20 }, actor);
    expect(helpdesk.listMine).toHaveBeenCalledWith("org-1", "u-1", { limit: 20 });

    await expect(controller.getById(7, testActor({ orgId: "org-attacker", userId: "u-9" }))).rejects.toThrow(NotFoundException);
    expect(helpdesk.getMine).toHaveBeenCalledWith("org-attacker", "u-9", 7);
  });
});

describe("HrHelpdeskController — the agent surface", () => {
  const agent = HrHelpdeskController.prototype;

  it("reads and queue work sit behind the agent view key; configuration behind manage", () => {
    expect(gateOf(agent.list)).toBe("hr:helpdesk:view");
    expect(gateOf(agent.listQueues)).toBe("hr:helpdesk:view");
    expect(gateOf(agent.getById)).toBe("hr:helpdesk:view");
    expect(gateOf(agent.update)).toBe("hr:helpdesk:view");
    expect(gateOf(agent.addComment)).toBe("hr:helpdesk:view");
    expect(gateOf(agent.configureQueue)).toBe("hr:helpdesk:manage");
    expect(gateOf(agent.listRouting)).toBe("hr:helpdesk:manage");
    expect(gateOf(agent.upsertRouting)).toBe("hr:helpdesk:manage");
    expect(gateOf(agent.deleteRouting)).toBe("hr:helpdesk:manage");
  });

  it("is module-gated on hr, unlike the employee surface", () => {
    expect(new Reflector().get(REQUIRE_MODULE, HrHelpdeskController)).toBe("hr");
  });

  it("a queue member without the agent view key is refused at the door, so the key must travel with the queue grant", async () => {
    await expect(
      (await guardHolding(["hr:helpdesk:queue-it"])).canActivate(
        makeGuardCtx(HrHelpdeskController, "list", member, MODULE_AVAILABLE),
      ),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      (await guardHolding(["hr:helpdesk:queue-it", "hr:helpdesk:view"])).canActivate(
        makeGuardCtx(HrHelpdeskController, "list", member, MODULE_AVAILABLE),
      ),
    ).resolves.toBe(true);
  });

  it("queue configuration refuses a queue member who is not the support administrator", async () => {
    await expect(
      (await guardHolding(["hr:helpdesk:view", "hr:helpdesk:queue-legal"])).canActivate(
        makeGuardCtx(HrHelpdeskController, "configureQueue", member, MODULE_AVAILABLE),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it("resolves queue membership from the held keys and treats manage and ownership as every queue", async () => {
    const access = {
      resolveUserPermissions: jest.fn().mockResolvedValue(
        new Map([
          ["hr:helpdesk:view", "all"],
          ["hr:helpdesk:queue-it", "all"],
          ["hr:helpdesk:queue-legal", "none"],
        ]),
      ),
    };
    const module = await Test.createTestingModule({ providers: [{ provide: AccessService, useValue: access }] }).compile();
    const accessService = module.get(AccessService);

    const memberActor = await resolveSupportActor(accessService, testActor({ orgId: "org-1", userId: "u-1" }));
    expect(memberActor.isAdmin).toBe(false);
    expect([...memberActor.queues]).toEqual(["IT"]);
    expect(memberActor.membershipId).toBe(1);

    const ownerActor = await resolveSupportActor(accessService, testActor({ orgId: "org-1", userId: "owner", isOrgOwner: true }));
    expect(ownerActor.isAdmin).toBe(true);
    expect(ownerActor.queues.size).toBe(5);
  });

  it("passes the resolved actor to the service, whose tenant predicate answers a foreign ticket with 404", async () => {
    const helpdesk = { getById: jest.fn().mockRejectedValue(new NotFoundException("Ticket not found.")) };
    const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Map([["hr:helpdesk:manage", "all"]])) };
    const module = await Test.createTestingModule({
      controllers: [HrHelpdeskController],
      providers: [
        { provide: HrHelpdeskService, useValue: helpdesk },
        { provide: HrHelpdeskConfigService, useValue: {} },
        { provide: AccessService, useValue: access },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(passThrough)
      .overrideGuard(PermissionGuard)
      .useValue(passThrough)
      .compile();
    const controller = module.get(HrHelpdeskController);

    await expect(controller.getById(99, testActor({ orgId: "org-attacker", userId: "u-1" }))).rejects.toThrow(NotFoundException);
    expect(helpdesk.getById).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-attacker", userId: "u-1", isAdmin: true }),
      99,
    );
  });
});
