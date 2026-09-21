import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import { invitationTransition } from "./invitations.helpers";

function collectColumnNames(root: unknown): string[] {
  const found: string[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && "columnType" in record) {
      found.push(record.name);
      continue;
    }
    for (const value of Object.values(record)) stack.push(value);
  }
  return found;
}

function makeTx(rowSets: { id: string }[][]) {
  let call = 0;
  const conditions: unknown[] = [];
  const returning = jest.fn(() => Promise.resolve(rowSets[call++] ?? []));
  const where = jest.fn().mockImplementation((condition: unknown) => {
    conditions.push(condition);
    return { returning };
  });
  const set = jest.fn().mockReturnValue({ where });
  const update = jest.fn().mockReturnValue({ set });
  return {
    tx: { update } as unknown as DbOrTx,
    set,
    update,
    columns: () => collectColumnNames(conditions),
  };
}

describe("invitationTransition", () => {
  it("returns null when the from-state guard finds no matching row, so a wrong-state transition does not apply", async () => {
    const { tx } = makeTx([[]]);
    const result = await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "ACCEPTED",
      to: "REVOKED",
    });
    expect(result).toBeNull();
  });

  it("returns the row when the from-state matches", async () => {
    const { tx, set } = makeTx([[{ id: "inv-1" }]]);
    const result = await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: "org-1",
      from: "PENDING",
      to: "REVOKED",
      patch: { revokedAt: new Date() },
    });
    expect(result).toEqual({ id: "inv-1" });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: "REVOKED" }));
  });

  it("returns null on a second sequential attempt, because the conditional UPDATE is what makes two concurrent accepts safe", async () => {
    const { tx } = makeTx([[{ id: "inv-1" }], []]);
    const first = await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "ACCEPTED",
    });
    const second = await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "ACCEPTED",
    });
    expect(first).toEqual({ id: "inv-1" });
    expect(second).toBeNull();
  });

  it("guards on status and accepted_at in SQL, so the transition cannot be won twice", async () => {
    const tx = makeTx([[{ id: "inv-1" }]]);
    await invitationTransition(tx.tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "ACCEPTED",
    });
    expect(tx.columns()).toEqual(
      expect.arrayContaining(["id", "status", "accepted_at"]),
    );
  });

  it("adds org_id to the predicate when a tenant is supplied, so a revoke cannot reach another org's invitation", async () => {
    const tx = makeTx([[{ id: "inv-1" }]]);
    await invitationTransition(tx.tx, {
      invitationId: "inv-1",
      orgId: "org-1",
      from: "PENDING",
      to: "REVOKED",
    });
    expect(tx.columns()).toContain("org_id");
  });

  it("omits org_id only when the caller passes null, which the token-authorized accept path does deliberately", async () => {
    const tx = makeTx([[{ id: "inv-1" }]]);
    await invitationTransition(tx.tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "ACCEPTED",
    });
    expect(tx.columns()).not.toContain("org_id");
  });

  it("merges the patch into the SET clause atomically with the status", async () => {
    const now = new Date();
    const { tx, set } = makeTx([[{ id: "inv-1" }]]);
    await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "DECLINED",
      patch: { declinedAt: now },
    });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ status: "DECLINED", declinedAt: now }),
    );
  });

  it("issues exactly one update per invocation", async () => {
    const { tx, update } = makeTx([[{ id: "inv-1" }]]);
    await invitationTransition(tx, {
      invitationId: "inv-1",
      orgId: null,
      from: "PENDING",
      to: "REVOKED",
    });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
