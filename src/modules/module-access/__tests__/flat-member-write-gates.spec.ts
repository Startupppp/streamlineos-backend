import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ModuleAccessFlatMembersService } from "../module-access-flat-members.service";
import { ModuleAccessGroupPolicyService } from "../module-access-group-policy.service";
import { AccessService } from "../../access/access.service";
import { CacheService } from "../../../common/cache/cache.service";
import { AuditService } from "../../../common/audit/audit.service";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import {
  assertGroupsBelongToModule,
  assertMayEditOwnerMemberships,
  type FlatMemberWriteDeps,
} from "../lib/flat-member-writes";

/**
 * The three flat-membership writes share a spine of gates that, before this
 * spec, nothing exercised: neutering any one of `assertFlatMemberWriteAllowed`,
 * `assertMayEditOwnerMemberships` or `assertGroupsBelongToModule` left all 231
 * module-access tests green, and the controller e2e auth matrix lists only the
 * `/groups` routes, not `/:moduleKey/members`. So an actor with no authority
 * over a module could have been given the run of its memberships by a one-line
 * deletion, in three places, with nothing red.
 *
 * The gate that decides WHETHER a caller may write is checked here through the
 * service, once per method, because the failure mode is a missing call as much
 * as a wrong rule. The two gates that decide WHAT may be written are checked
 * directly against the library, where they are pure.
 */

function makeActor(overrides: Partial<CurrentUserContext> = {}): CurrentUserContext {
  return {
    userId: "u-actor",
    orgId: "org-1",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
    ...overrides,
  };
}

async function buildService(isModuleEnabled: boolean) {
  const db = {
    select: jest.fn(() => {
      throw new Error("no query should run once a gate has refused the write");
    }),
    query: {
      organizationMembers: {
        findFirst: jest.fn(() => {
          throw new Error("no query should run once a gate has refused the write");
        }),
      },
    },
  };

  const m = await Test.createTestingModule({
    providers: [
      ModuleAccessFlatMembersService,
      ModuleAccessGroupPolicyService,
      { provide: DRIZZLE, useValue: db },
      {
        provide: AccessService,
        useValue: {
          isModuleEnabled: jest.fn().mockResolvedValue(isModuleEnabled),
          resolveUserPermissions: jest.fn().mockResolvedValue(new Map<string, string>()),
        },
      },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();

  return { svc: m.get(ModuleAccessFlatMembersService), db };
}

describe("flat-member writes — every method runs the write gate", () => {
  const calls: ReadonlyArray<
    [string, (svc: ModuleAccessFlatMembersService, moduleKey: string) => Promise<unknown>]
  > = [
    ["addMember", (svc, key) => svc.addMember(makeActor(), key, { userId: "u-t", groupIds: [1] })],
    [
      "updateMemberGroups",
      (svc, key) => svc.updateMemberGroups(makeActor(), key, "u-t", { groupIds: [1] }),
    ],
    ["removeMember", (svc, key) => svc.removeMember(makeActor(), key, "u-t")],
  ];

  it.each(calls)("%s refuses an unmanaged module with 404", async (_name, call) => {
    const { svc, db } = await buildService(true);
    await expect(call(svc, "billing")).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it.each(calls)("%s refuses a module the org has not enabled", async (_name, call) => {
    const { svc } = await buildService(false);
    await expect(call(svc, "hr")).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("assertMayEditOwnerMemberships", () => {
  it("refuses a module manager who is neither the owner nor an org owner", () => {
    expect(() =>
      assertMayEditOwnerMemberships(makeActor({ userId: "u-manager" }), "u-owner", "u-owner"),
    ).toThrow(ForbiddenException);
  });

  it("allows the module owner to edit their own memberships", () => {
    expect(() =>
      assertMayEditOwnerMemberships(makeActor({ userId: "u-owner" }), "u-owner", "u-owner"),
    ).not.toThrow();
  });

  it("allows an org owner", () => {
    expect(() =>
      assertMayEditOwnerMemberships(
        makeActor({ userId: "u-manager", isOrgOwner: true }),
        "u-owner",
        "u-owner",
      ),
    ).not.toThrow();
  });

  it("says nothing about a target who is not the module owner", () => {
    const manager = makeActor({ userId: "u-manager" });
    expect(() => assertMayEditOwnerMemberships(manager, "u-someone", "u-owner")).not.toThrow();
    expect(() => assertMayEditOwnerMemberships(manager, "u-someone", null)).not.toThrow();
  });
});

describe("assertGroupsBelongToModule", () => {
  function depsReturning(rows: Array<{ id: number }>): FlatMemberWriteDeps {
    const resolved = Promise.resolve(rows);
    const where = jest.fn().mockReturnValue({
      then: resolved.then.bind(resolved),
      catch: resolved.catch.bind(resolved),
    });
    const from = jest.fn().mockReturnValue({ where });
    return { db: { select: jest.fn().mockReturnValue({ from }) } } as unknown as FlatMemberWriteDeps;
  }

  it("refuses when a requested group is not one of the module's own", async () => {
    await expect(
      assertGroupsBelongToModule(depsReturning([{ id: 1 }]), "org-1", "hr", [1, 2]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("passes when every requested group came back", async () => {
    await expect(
      assertGroupsBelongToModule(depsReturning([{ id: 1 }, { id: 2 }]), "org-1", "hr", [1, 2]),
    ).resolves.toBeUndefined();
  });
});
