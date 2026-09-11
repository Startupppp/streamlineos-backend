import { Test } from "@nestjs/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AccessService } from "../../access/access.service";
import { MembershipStateService } from "../../../common/auth/membership-state.service";
import { BuildNotificationContextService } from "./build-notification-context.service";
import { runInTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { agentTokenPrincipal, personalTokenPrincipal } from "../../../common/auth/principal";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { resolvePrincipalScope } from "../../access/access-principal-scope";

jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInTenantTransaction: jest.fn(async (db: unknown, work: (tx: unknown) => Promise<unknown>) => work(db)),
}));

describe("Build notification context batching", () => {
  async function harness(scope: string, active = true) {
    const limit = jest.fn().mockResolvedValue([{
      id: 11, ticketNumber: 3, priority: "HIGH", status: "TODO", type: "TASK", projectKey: "SEC",
      assigneeId: "assignee", assigneeName: "Allowed person", assigneeFirstName: null,
      assigneeLastName: null, assigneeImage: null,
    }]);
    const captured: SQL[] = [];
    const chain = {
      innerJoin: jest.fn((): object => chain), leftJoin: jest.fn((): object => chain),
      where: jest.fn((predicate: SQL) => { captured.push(predicate); return { limit }; }),
    };
    const select = jest.fn(() => ({ from: jest.fn(() => chain) }));
    const resolve = jest.fn().mockResolvedValue({ active, membershipId: active ? 7 : null, role: "MEMBER", isOwner: false });
    const scopeFor = jest.fn().mockResolvedValue(scope);
    const module = await Test.createTestingModule({ providers: [
      BuildNotificationContextService,
      { provide: DRIZZLE, useValue: { select } },
      { provide: MembershipStateService, useValue: { resolve } },
      { provide: AccessService, useValue: { scopeFor } },
    ] }).compile();
    return { module, service: module.get(BuildNotificationContextService), select, limit, resolve, scopeFor, captured };
  }

  beforeEach(() => jest.clearAllMocks());

  it("resolves membership and permission once, then fetches one projected bounded batch", async () => {
    const h = await harness("own");
    try {
      const result = await h.service.resolve("org-a", "user-a", [11, 11, 12]);
      expect(result.get(11)?.ticketKey).toBe("SEC-3");
      expect(h.resolve).toHaveBeenCalledTimes(1);
      expect(h.scopeFor).toHaveBeenCalledTimes(1);
      expect(h.scopeFor).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org-a", userId: "user-a" }), "build:manage");
      expect(h.select).toHaveBeenCalledTimes(1);
      expect(h.limit).toHaveBeenCalledWith(2);
      expect(runInTenantTransaction).toHaveBeenCalledWith(expect.anything(), expect.any(Function), { orgId: "org-a" });
      const predicate = h.captured[0];
      if (!predicate) throw new Error("Ticket query must have an authorization predicate");
      const query = new PgDialect().sqlToQuery(predicate);
      expect(query.params).toEqual(expect.arrayContaining(["org-a", "user-a", 11, 12]));
      expect(query.sql).toContain("deleted_at");
      expect(query.sql).toContain("reporter_id");
      expect(query.sql).toContain("assignee_membership_id");
    } finally { await h.module.close(); }
  });

  it("does not query tickets after permission revocation", async () => {
    const h = await harness("none");
    try {
      expect((await h.service.resolve("org-a", "user-a", [11])).size).toBe(0);
      expect(h.select).not.toHaveBeenCalled();
      expect(runInTenantTransaction).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it("does not resolve grants or ticket data for an inactive membership", async () => {
    const h = await harness("all", false);
    try {
      expect((await h.service.resolve("org-a", "user-a", [11])).size).toBe(0);
      expect(h.scopeFor).not.toHaveBeenCalled();
      expect(h.select).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });

  it.each([
    personalTokenPrincipal(7, false, "pat", ["notifications:read"]),
    agentTokenPrincipal(7, 42, ["notifications:read"]),
  ])("preserves $kind ceiling rather than upgrading to human authority", async (principal) => {
    const h = await harness("all");
    h.scopeFor.mockImplementation((user: CurrentUserContext, key: string) =>
      resolvePrincipalScope(user.principal, key, async () => "all"),
    );
    try {
      expect((await h.service.resolve("org-a", "user-a", [11], principal)).size).toBe(0);
      expect(h.select).not.toHaveBeenCalled();
      expect(h.scopeFor).toHaveBeenCalledWith(expect.objectContaining({ principal }), "build:manage");
    } finally { await h.module.close(); }
  });

  it("refuses a principal for a different membership before resolving grants", async () => {
    const h = await harness("all");
    try {
      expect((await h.service.resolve("org-a", "user-a", [11], personalTokenPrincipal(88, false, "pat", ["build:manage"]))).size).toBe(0);
      expect(h.scopeFor).not.toHaveBeenCalled();
      expect(h.select).not.toHaveBeenCalled();
    } finally { await h.module.close(); }
  });
});
