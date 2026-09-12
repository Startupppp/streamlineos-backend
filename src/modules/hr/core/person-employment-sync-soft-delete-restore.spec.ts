import { resolveOrganizationPeople } from "./person-employment-sync-batch-people";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { EnsureManyInput } from "./person-employment-sync-batch.types";

const ORG = "org-1";

interface PersonRow {
  organizationPersonId: string;
  userId: string | null;
  workEmail: string | null;
  deletedAt: Date | null;
}

function buildTx(rows: PersonRow[]) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where });
  const select = jest.fn().mockReturnValue({ from });
  const returning = jest.fn().mockResolvedValue([]);
  const values = jest.fn().mockReturnValue({ returning });
  const insert = jest.fn().mockReturnValue({ values });
  const execute = jest.fn().mockResolvedValue([]);
  return { select, insert, execute, values, returning, limit };
}

function input(userId: string, workEmail: string): EnsureManyInput {
  return {
    userId,
    workEmail,
    firstName: "Ada",
    lastName: "Lovelace",
    employeeNumber: `EMP-${userId}`,
  };
}

describe("resolveOrganizationPeople — soft-deleted person is restored, never re-inserted", () => {
  it("reuses a soft-deleted person matched by user and does not insert", async () => {
    const tx = buildTx([
      {
        organizationPersonId: "op-deleted-1",
        userId: "user-1",
        workEmail: "ada@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const resolved = await resolveOrganizationPeople(tx as unknown as DbOrTx, ORG, [
      input("user-1", "Ada@Example.com"),
    ]);

    expect(resolved.get("user-1")).toBe("op-deleted-1");
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("reuses a soft-deleted person matched by work email when the user id differs", async () => {
    const tx = buildTx([
      {
        organizationPersonId: "op-deleted-2",
        userId: null,
        workEmail: " Ada@Example.COM ",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const resolved = await resolveOrganizationPeople(tx as unknown as DbOrTx, ORG, [
      input("user-2", "ada@example.com"),
    ]);

    expect(resolved.get("user-2")).toBe("op-deleted-2");
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("prefers a live person over a soft-deleted one for the same user", async () => {
    const tx = buildTx([
      {
        organizationPersonId: "op-deleted-3",
        userId: "user-3",
        workEmail: "ada@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        organizationPersonId: "op-live-3",
        userId: "user-3",
        workEmail: "ada@example.com",
        deletedAt: null,
      },
    ]);

    const resolved = await resolveOrganizationPeople(tx as unknown as DbOrTx, ORG, [
      input("user-3", "ada@example.com"),
    ]);

    expect(resolved.get("user-3")).toBe("op-live-3");
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("inserts when there is neither a live nor a soft-deleted person", async () => {
    const tx = buildTx([]);
    tx.returning.mockResolvedValue([
      { organizationPersonId: "op-new-4", userId: "user-4" },
    ]);

    const resolved = await resolveOrganizationPeople(tx as unknown as DbOrTx, ORG, [
      input("user-4", "new@example.com"),
    ]);

    expect(resolved.get("user-4")).toBe("op-new-4");
    expect(tx.execute).not.toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it("restores many soft-deleted people in one statement", async () => {
    const tx = buildTx([
      {
        organizationPersonId: "op-a",
        userId: "user-a",
        workEmail: "a@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
      {
        organizationPersonId: "op-b",
        userId: "user-b",
        workEmail: "b@example.com",
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    ]);

    const resolved = await resolveOrganizationPeople(tx as unknown as DbOrTx, ORG, [
      input("user-a", "a@example.com"),
      input("user-b", "b@example.com"),
    ]);

    expect(resolved.get("user-a")).toBe("op-a");
    expect(resolved.get("user-b")).toBe("op-b");
    expect(tx.execute).toHaveBeenCalledTimes(1);
    expect(tx.insert).not.toHaveBeenCalled();
  });
});
