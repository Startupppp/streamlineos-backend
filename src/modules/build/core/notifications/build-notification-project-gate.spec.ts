import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { MembershipStateService } from "../../../../common/auth/membership-state.service";
import { NotificationVisibilityRegistry, IMPLEMENTED_VISIBILITY_RESOURCE_KINDS } from "../../../notifications/notification-visibility.registry";
import { NOTIFICATION_EVENT_MAP } from "../../../notifications/notification-events.catalog";
import { BUILD_APPROVAL_RESOURCE, BUILD_RELEASE_RESOURCE } from "../../../notifications/notification-events-build.catalog";
import { BuildNotificationContextService } from "./build-notification-context.service";
import { BuildNotificationVisibility } from "./build-notification-visibility";
import { principalAccess, type StandingScopes } from "../project-crud/__tests__/project-access-doubles";

jest.mock("../../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(async (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db)),
}));

const dialect = new PgDialect();

function harness(grants: StandingScopes, rows: object[] = [], isOwner = false) {
  const captured: SQL[] = [];
  const limit = jest.fn().mockResolvedValue(rows);
  const chain = {
    innerJoin: jest.fn((): object => chain),
    leftJoin: jest.fn((): object => chain),
    where: jest.fn((predicate: SQL) => {
      captured.push(predicate);
      return { limit };
    }),
  };
  const select = jest.fn(() => ({ from: jest.fn(() => chain) }));
  const membership = {
    resolve: jest.fn().mockResolvedValue({ active: true, membershipId: 7, role: "MEMBER", isOwner }),
  } as unknown as MembershipStateService;
  const access = principalAccess(grants) as unknown as AccessService;
  const service = new BuildNotificationContextService({ select } as unknown as Db, access, membership);
  return { service, captured, select };
}

const rendered = (predicate: SQL | undefined) => {
  if (!predicate) throw new Error("the read must carry an authorization predicate");
  return dialect.sqlToQuery(predicate).sql;
};

const ticketRow = {
  id: 11, ticketNumber: 3, priority: "HIGH", status: "TODO", type: "TASK", projectKey: "SEC",
  assigneeId: null, assigneeName: null, assigneeFirstName: null, assigneeLastName: null, assigneeImage: null,
};

describe("ticket notification context is gated by the project-access visibility decision, not ticket scope alone", () => {
  it("adds the project relationship to the ticket predicate for a recipient who is not org-wide", async () => {
    const h = harness({ "build:view": "own", "build:tickets:view": "all" }, [ticketRow]);
    const contexts = await h.service.resolve("org-a", "user-a", [11]);
    expect(contexts.get(11)?.ticketKey).toBe("SEC-3");
    expect(rendered(h.captured[0])).toContain("project_members");
  });

  it("matches no ticket for a recipient with org-wide ticket view but no project standing, so the notification is suppressed", async () => {
    const h = harness({ "build:tickets:view": "all" });
    await h.service.resolve("org-a", "user-a", [11]);
    const sql = rendered(h.captured[0]);
    expect(sql).not.toContain("project_members");
    expect(sql).toContain("false");
  });
});

describe("release and approval notifications carry a project visibility gate", () => {
  it("declares a registered resource kind on both catalog events", () => {
    expect(NOTIFICATION_EVENT_MAP.get("build.release.published")?.visibilityResourceKind).toBe(BUILD_RELEASE_RESOURCE);
    expect(NOTIFICATION_EVENT_MAP.get("build.approval.requested")?.visibilityResourceKind).toBe(BUILD_APPROVAL_RESOURCE);
    expect(IMPLEMENTED_VISIBILITY_RESOURCE_KINDS).toEqual(expect.arrayContaining([BUILD_RELEASE_RESOURCE, BUILD_APPROVAL_RESOURCE]));
  });

  it("registers a resolver for each kind so the dispatch-time re-check does not deny every delivery", async () => {
    const registry = new NotificationVisibilityRegistry();
    const h = harness({ "build:view": "own" }, [{ id: 1 }]);
    new BuildNotificationVisibility(h.service, registry).onModuleInit();
    await expect(registry.canSee(BUILD_RELEASE_RESOURCE, "org-a", "user-a", "5")).resolves.toBe(true);
    await expect(registry.canSee(BUILD_APPROVAL_RESOURCE, "org-a", "user-a", "5")).resolves.toBe(true);
  });

  it("hides a release from a recipient with no project standing without querying it", async () => {
    const h = harness({});
    await expect(h.service.canSeeRelease("org-a", "user-a", 5)).resolves.toBe(false);
    expect(h.select).not.toHaveBeenCalled();
  });

  it("filters a release through the recipient's project relationship and shows it when the row comes back", async () => {
    const h = harness({ "build:view": "own" }, [{ id: 5 }]);
    await expect(h.service.canSeeRelease("org-a", "user-a", 5)).resolves.toBe(true);
    expect(rendered(h.captured[0])).toContain("project_members");
  });

  it("lets the assigned approver or a project member see an approval, through one predicate", async () => {
    const h = harness({ "build:view": "own" }, []);
    await expect(h.service.canSeeApproval("org-a", "user-a", 4)).resolves.toBe(false);
    const sql = rendered(h.captured[0]);
    expect(sql).toContain("approver_membership_id");
    expect(sql).toContain("project_members");
  });
});
