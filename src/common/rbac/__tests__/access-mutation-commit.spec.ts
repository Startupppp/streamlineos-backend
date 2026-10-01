import { commitAccessChange, type CommitAccessAudit } from "../access-mutation-commit";
import { bumpPermissionsVersion } from "../access-invalidate";
import { getObservabilityContext } from "../../observability/observability-context";
import { getImpersonationContext } from "../../impersonation/impersonation-context";
import { registerAfterCommit } from "../../tenant/tenant-context";

jest.mock("../access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../observability/observability-context", () => ({
  getObservabilityContext: jest.fn().mockReturnValue(null),
}));

jest.mock("../../impersonation/impersonation-context", () => ({
  getImpersonationContext: jest.fn().mockReturnValue(null),
}));

jest.mock("../../tenant/tenant-context", () => ({
  registerAfterCommit: jest.fn().mockReturnValue(true),
}));



function makeTx() {
  const insertedRows: unknown[] = [];
  const tx = {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation((row: unknown) => {
        insertedRows.push(row);
        return Promise.resolve();
      }),
    }),
  };
  return { tx, insertedRows };
}

const ORG = "org-commit-test";



describe("commitAccessChange — version bump", () => {
  beforeEach(() => jest.clearAllMocks());

  it("calls bumpPermissionsVersion with the supplied tx and orgId so the bump is atomic with the mutation", async () => {
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(bumpPermissionsVersion).toHaveBeenCalledWith(tx, ORG);
  });

  it("(negative) does not call bumpPermissionsVersion with a different tx handle — cross-tx bump is a bug", async () => {
    const { tx } = makeTx();
    const { tx: other } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(bumpPermissionsVersion).not.toHaveBeenCalledWith(other, ORG);
  });

  it("always bumps even when opts is omitted so callers without audit needs still invalidate", async () => {
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(bumpPermissionsVersion).toHaveBeenCalledTimes(1);
  });
});



describe("commitAccessChange — audit row", () => {
  beforeEach(() => jest.clearAllMocks());

  it("writes an audit row inside the same tx handle when opts.audit is supplied so the audit rolls back with the change on failure", async () => {
    const { tx, insertedRows } = makeTx();
    const audit: CommitAccessAudit = {
      action: "test.committed",
      userId: "u-1",
    };
    await commitAccessChange(tx, ORG, { audit });
    expect(tx.insert).toHaveBeenCalledTimes(1);
    expect(insertedRows[0]).toMatchObject({
      action: "test.committed",
      userId: "u-1",
      orgId: ORG,
    });
  });

  it("(negative) does not write an audit row when opts.audit is omitted — callers without audit intent do not produce phantom rows", async () => {
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("accepts systemActor in place of userId and stores it in metadata so machine principals are attributable", async () => {
    const { tx, insertedRows } = makeTx();
    const audit: CommitAccessAudit = {
      action: "system.action",
      systemActor: "seed-script",
    };
    await commitAccessChange(tx, ORG, { audit });
    expect(insertedRows[0]).toMatchObject({
      userId: null,
      metadata: expect.objectContaining({ systemActor: "seed-script" }),
    });
  });

  it("merges impersonation context into audit metadata so the real actor is always recorded", async () => {
    jest.mocked(getImpersonationContext).mockReturnValueOnce({
      realActorUserId: "admin-u",
      impersonationSessionId: "imp-session-1",
    } as ReturnType<typeof getImpersonationContext>);
    const { tx, insertedRows } = makeTx();
    await commitAccessChange(tx, ORG, {
      audit: { action: "a.b", userId: "impersonated-u" },
    });
    expect(insertedRows[0]).toMatchObject({
      metadata: expect.objectContaining({
        impersonatedBy: "admin-u",
        impersonationSessionId: "imp-session-1",
      }),
    });
  });

  it("(negative) does not include impersonation keys when there is no impersonation context — clean metadata for direct actor calls", async () => {
    jest.mocked(getImpersonationContext).mockReturnValueOnce(null);
    const { tx, insertedRows } = makeTx();
    await commitAccessChange(tx, ORG, {
      audit: { action: "a.b", userId: "u-1" },
    });
    expect((insertedRows[0] as Record<string, unknown>).metadata).not.toHaveProperty(
      "impersonatedBy",
    );
  });

  it("stores ipAddress from observability context in the audit row so IP-based forensics are possible", async () => {
    jest.mocked(getObservabilityContext).mockReturnValueOnce({ ipAddress: "1.2.3.4" });
    const { tx, insertedRows } = makeTx();
    await commitAccessChange(tx, ORG, {
      audit: { action: "a.b", userId: "u-1" },
    });
    expect(insertedRows[0]).toMatchObject({ ipAddress: "1.2.3.4" });
  });
});



describe("commitAccessChange — afterCommit (BE-85)", () => {
  beforeEach(() => jest.clearAllMocks());

  it("registers the afterCommit hook when registerAfterCommit returns true so the work runs outside the transaction", async () => {
    jest.mocked(registerAfterCommit).mockReturnValue(true);
    const work = jest.fn().mockResolvedValue(undefined);
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG, { afterCommit: work });
    expect(registerAfterCommit).toHaveBeenCalledWith(work);
    expect(work).not.toHaveBeenCalled();
  });

  it("runs the hook inline when registerAfterCommit returns false so revocation is not silently dropped in background contexts", async () => {
    jest.mocked(registerAfterCommit).mockReturnValue(false);
    const work = jest.fn().mockResolvedValue(undefined);
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG, { afterCommit: work });
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("(negative) does not call the hook inline when registerAfterCommit succeeds — double execution is a bug", async () => {
    jest.mocked(registerAfterCommit).mockReturnValue(true);
    const work = jest.fn().mockResolvedValue(undefined);
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG, { afterCommit: work });
    expect(work).toHaveBeenCalledTimes(0);
  });

  it("skips afterCommit registration when opts.afterCommit is omitted so there is no dangling no-op hook", async () => {
    const { tx } = makeTx();
    await commitAccessChange(tx, ORG);
    expect(registerAfterCommit).not.toHaveBeenCalled();
  });
});
