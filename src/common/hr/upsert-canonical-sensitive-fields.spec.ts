import { upsertCanonicalSensitiveFields } from "./sync-canonical-sensitive-fields";

function makeDb(employments: { id: number }[]) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const values = jest.fn(() => ({ onConflictDoUpdate }));
  const insert = jest.fn(() => ({ values }));
  const builder = {
    from: jest.fn(() => builder),
    innerJoin: jest.fn(() => builder),
    where: jest.fn(() => builder),
    limit: jest.fn(() => Promise.resolve(employments)),
  };
  return {
    db: { select: jest.fn(() => builder), insert, update: jest.fn() },
    insert,
    values,
    onConflictDoUpdate,
  };
}

describe("a self-service bank save must land, not report success over a zero-row update", () => {
  it("creates the canonical row when the employee has a primary employment but no sensitive record yet", async () => {
    const { db, values, onConflictDoUpdate } = makeDb([{ id: 77 }]);

    await expect(
      upsertCanonicalSensitiveFields(db as never, "org-1", "user-1", {
        bankDetails: {
          accountNumber: "12345678",
          bankName: "",
          branch: "",
          ifsc: "SBIN0001234",
          accountHolder: "Ada",
        },
      }),
    ).resolves.toBe(true);

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", employmentId: 77 }),
    );
    expect(onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports false rather than inventing an employment when the person has none", async () => {
    const { db, insert } = makeDb([]);

    await expect(
      upsertCanonicalSensitiveFields(db as never, "org-1", "user-1", { taxId: "ABCDE1234F" }),
    ).resolves.toBe(false);

    expect(insert).not.toHaveBeenCalled();
  });
});
