jest.mock("../../../common/rbac/assert-may-grant-role", () => ({
  assertMayGrantRole: jest.fn().mockResolvedValue(undefined),
}));

import { ConflictException } from "@nestjs/common";
import { InvitationCreateService } from "./invitation-create.service";
import { canonicalAdmissionEmail } from "./membership-admission.service";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";

interface InviteAuthorizedSeam {
  inviteAuthorized(
    orgId: string,
    actorUserId: string,
    email: string,
    role: string,
    delivery?: "background" | "enqueue",
  ): Promise<{
    success: true;
    invitationId: string;
    organizationName: string;
    resent: boolean;
  }>;
}

function seam(service: InvitationCreateService): InviteAuthorizedSeam {
  return service as never;
}

function makeService(): InvitationCreateService {
  return new InvitationCreateService(
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
    null as never,
  );
}

describe("InvitationCreateService.bulkInvite — email deduplication (P2)", () => {
  const orgId = "org-1";
  const actor = { userId: "actor-1", isOrgOwner: false };
  const role = "MEMBER";

  it("3 canonical-duplicate inputs → 1 inviteAuthorized call, 2 duplicate results", async () => {
    const service = makeService();
    const inviteAuthorized = jest.fn().mockResolvedValue({
      success: true,
      invitationId: "inv-1",
      organizationName: "Acme",
      resent: false,
    });
    jest.spyOn(seam(service), "inviteAuthorized").mockImplementation(inviteAuthorized);

    const result = await service.bulkInvite(
      orgId,
      actor,
      ["A@x.com", " a@X.com ", "a@x.com"],
      role,
      "enqueue",
    );

    expect(inviteAuthorized).toHaveBeenCalledTimes(1);
    expect(inviteAuthorized).toHaveBeenCalledWith(
      orgId,
      actor.userId,
      "a@x.com",
      role,
      "enqueue",
    );

    const successes = result.results.filter((r) => r.success);
    const duplicates = result.results.filter((r) => r.isDuplicate === true);

    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({
      email: "a@x.com",
      originalEmail: "A@x.com",
      success: true,
      invitationId: "inv-1",
    });

    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]).toMatchObject({
      originalEmail: " a@X.com ",
      success: false,
      isDuplicate: true,
    });
    expect(duplicates[1]).toMatchObject({
      originalEmail: "a@x.com",
      success: false,
      isDuplicate: true,
    });
  });

  it("preserves the original email spelling in the result for each duplicate", async () => {
    const service = makeService();
    jest.spyOn(seam(service), "inviteAuthorized").mockResolvedValue({
      success: true,
      invitationId: "inv-2",
      organizationName: "Acme",
      resent: false,
    });

    const result = await service.bulkInvite(
      orgId,
      actor,
      ["Bob@EXAMPLE.COM", "bob@example.com", "  BOB@example.com  "],
      role,
    );

    expect(result.results.map((r) => r.originalEmail)).toEqual([
      "Bob@EXAMPLE.COM",
      "bob@example.com",
      "  BOB@example.com  ",
    ]);
  });

  it("3 distinct canonical emails → 3 inviteAuthorized calls, 0 duplicates", async () => {
    const service = makeService();
    const inviteAuthorized = jest.fn().mockImplementation(
      (_org: unknown, _actor: unknown, email: string) =>
        Promise.resolve({
          success: true,
          invitationId: `inv-${email}`,
          organizationName: "Acme",
          resent: false,
        }),
    );
    jest.spyOn(seam(service), "inviteAuthorized").mockImplementation(inviteAuthorized);

    const result = await service.bulkInvite(
      orgId,
      actor,
      ["alice@example.com", "bob@example.com", "carol@example.com"],
      role,
    );

    expect(inviteAuthorized).toHaveBeenCalledTimes(3);
    expect(result.results.filter((r) => r.success)).toHaveLength(3);
    expect(result.results.filter((r) => r.isDuplicate)).toHaveLength(0);
  });

  it("canonicalAdmissionEmail normalises the whitespace-and-case variants used above", () => {
    expect(canonicalAdmissionEmail("A@x.com")).toBe("a@x.com");
    expect(canonicalAdmissionEmail(" a@X.com ")).toBe("a@x.com");
    expect(canonicalAdmissionEmail("a@x.com")).toBe("a@x.com");
  });
});

describe("InvitationCreateService.bulkInvite — one bad recipient never voids the batch (P12)", () => {
  const orgId = "org-1";
  const actor = { userId: "actor-1", isOrgOwner: true };
  const role = "MEMBER";

  it("keeps inviting after a recipient the organization already holds", async () => {
    const service = makeService();
    const calls: string[] = [];
    jest
      .spyOn(seam(service), "inviteAuthorized")
      .mockImplementation(async (_orgId, _actorUserId, email) => {
        calls.push(email);
        if (email === "owner@acme.test")
          throw new Error("User is already a member of this organization");
        return {
          success: true as const,
          invitationId: `inv-${email}`,
          organizationName: "Acme",
          resent: false,
        };
      });

    const { results } = await service.bulkInvite(
      orgId,
      actor,
      ["owner@acme.test", "first@acme.test", "second@acme.test"],
      role,
    );

    expect(calls).toEqual(["owner@acme.test", "first@acme.test", "second@acme.test"]);
    expect(results.map((row) => row.success)).toEqual([false, true, true]);
  });

  it("names the failing recipient and the reason, without naming the others", async () => {
    const service = makeService();
    jest
      .spyOn(seam(service), "inviteAuthorized")
      .mockImplementation(async (_orgId, _actorUserId, email) => {
        if (email === "owner@acme.test")
          throw new Error("User is already a member of this organization");
        return {
          success: true as const,
          invitationId: `inv-${email}`,
          organizationName: "Acme",
          resent: false,
        };
      });

    const { results } = await service.bulkInvite(
      orgId,
      actor,
      ["owner@acme.test", "first@acme.test"],
      role,
    );

    expect(results[0]).toMatchObject({
      email: "owner@acme.test",
      success: false,
      error: "User is already a member of this organization",
    });
    expect(results[1]).toMatchObject({ email: "first@acme.test", success: true });
    expect(results[1]?.error).toBeUndefined();
  });

  it("reports a wholly failed batch as rows, never as a thrown batch error", async () => {
    const service = makeService();
    jest
      .spyOn(seam(service), "inviteAuthorized")
      .mockRejectedValue(new Error("Email domain not allowed"));

    await expect(
      service.bulkInvite(orgId, actor, ["a@other.test", "b@other.test"], role),
    ).resolves.toMatchObject({
      results: [
        { email: "a@other.test", success: false, error: "Email domain not allowed" },
        { email: "b@other.test", success: false, error: "Email domain not allowed" },
      ],
    });
  });
});

const ABORTED_MESSAGE =
  "current transaction is aborted, commands ignored until end of transaction block (25P02)";

/**
 * A transaction that behaves the way PostgreSQL actually does: one failed statement puts the
 * whole transaction in the aborted state, every later statement raises 25P02, and only a
 * ROLLBACK TO SAVEPOINT restores it. `transaction()` is what a nested postgres-js transaction is.
 */
class AbortableTransaction {
  aborted = false;
  readonly applied: string[] = [];
  readonly refused: string[] = [];

  statement(label: string): void {
    if (this.aborted) {
      this.refused.push(label);
      throw new Error(ABORTED_MESSAGE);
    }
    this.applied.push(label);
  }

  abortAndThrow(label: string, error: Error): never {
    if (this.aborted) {
      this.refused.push(label);
      throw new Error(ABORTED_MESSAGE);
    }
    this.aborted = true;
    throw error;
  }

  async transaction<T>(fn: (tx: AbortableTransaction) => Promise<T>): Promise<T> {
    const entryState = this.aborted;
    try {
      return await fn(this);
    } catch (error) {
      this.aborted = entryState;
      throw error;
    }
  }
}

describe("InvitationCreateService.bulkInvite — one duplicate row never aborts the batch (P12)", () => {
  const orgId = "org-1";
  const actor = { userId: "actor-1", isOrgOwner: true };
  const role = "MEMBER";
  const DUPLICATE_MESSAGE = "An invitation is already pending for this email";

  function inAmbientTransaction<T>(
    tx: AbortableTransaction,
    fn: () => Promise<T>,
  ): Promise<T> {
    return runWithTenantContext(
      {
        orgId,
        audience: "INTERNAL",
        tx: tx as unknown as TenantTx,
        afterCommit: [],
      },
      fn,
    );
  }

  function arrange(duplicateEmail: string) {
    const service = makeService();
    const tx = new AbortableTransaction();
    jest
      .spyOn(seam(service), "inviteAuthorized")
      .mockImplementation(async (_orgId, _actorUserId, email) => {
        if (email === duplicateEmail)
          tx.abortAndThrow(
            `insert:${email}`,
            new ConflictException(DUPLICATE_MESSAGE),
          );
        tx.statement(`insert:${email}`);
        return {
          success: true as const,
          invitationId: `inv-${email}`,
          organizationName: "Acme",
          resent: false,
        };
      });
    return { service, tx };
  }

  it("the double models PostgreSQL: with no savepoint a later statement raises 25P02", () => {
    const tx = new AbortableTransaction();

    expect(() =>
      tx.abortAndThrow("insert:dup", new ConflictException(DUPLICATE_MESSAGE)),
    ).toThrow(DUPLICATE_MESSAGE);
    expect(() => tx.statement("insert:third")).toThrow(/25P02/);
    expect(tx.refused).toEqual(["insert:third"]);
  });

  it("a duplicate email mid-batch leaves every other recipient created", async () => {
    const { service, tx } = arrange("dup@acme.test");

    const { results } = await inAmbientTransaction(tx, () =>
      service.bulkInvite(
        orgId,
        actor,
        ["first@acme.test", "dup@acme.test", "third@acme.test"],
        role,
        "enqueue",
      ),
    );

    expect(results.map((row) => row.success)).toEqual([true, false, true]);
    expect(tx.applied).toEqual([
      "insert:first@acme.test",
      "insert:third@acme.test",
    ]);
    expect(tx.refused).toEqual([]);
  });

  it("the failed row reports the duplicate reason, never 25P02", async () => {
    const { service, tx } = arrange("dup@acme.test");

    const { results } = await inAmbientTransaction(tx, () =>
      service.bulkInvite(
        orgId,
        actor,
        ["first@acme.test", "dup@acme.test", "third@acme.test"],
        role,
        "enqueue",
      ),
    );

    expect(results[1]).toMatchObject({
      email: "dup@acme.test",
      success: false,
      error: DUPLICATE_MESSAGE,
    });
    for (const row of results) expect(row.error ?? "").not.toContain("25P02");
  });

  it("the ambient transaction is still usable after a duplicate row", async () => {
    const { service, tx } = arrange("dup@acme.test");

    await inAmbientTransaction(tx, () =>
      service.bulkInvite(
        orgId,
        actor,
        ["first@acme.test", "dup@acme.test", "third@acme.test"],
        role,
        "enqueue",
      ),
    );

    expect(tx.aborted).toBe(false);
    expect(() => tx.statement("post-batch-write")).not.toThrow();
    expect(tx.applied).toContain("post-batch-write");
  });

  it("a batch whose FIRST row is the duplicate still creates the rest", async () => {
    const { service, tx } = arrange("dup@acme.test");

    const { results } = await inAmbientTransaction(tx, () =>
      service.bulkInvite(
        orgId,
        actor,
        ["dup@acme.test", "second@acme.test", "third@acme.test"],
        role,
        "enqueue",
      ),
    );

    expect(results.map((row) => row.success)).toEqual([false, true, true]);
    expect(results[0]?.error).toBe(DUPLICATE_MESSAGE);
    expect(tx.applied).toEqual([
      "insert:second@acme.test",
      "insert:third@acme.test",
    ]);
    expect(tx.refused).toEqual([]);
  });
});
