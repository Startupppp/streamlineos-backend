import type { Db } from "../../../db/drizzle.module";
import { IntegrationsGitService } from "./integrations-git.service";

describe("IntegrationsGitService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";
  const CONN_ID = 99;

  function makeDb(resolvedOrgId: string | null) {
    return {
      execute: jest.fn().mockResolvedValue(resolvedOrgId ? [{ org_id: resolvedOrgId }] : []),
      query: {
        gitConnections: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>, opts?: unknown) => {
        const tx = {
          query: { gitConnections: { findFirst: jest.fn().mockResolvedValue(null) } },
          select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
          insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
        };
        return fn(tx);
      }),
    } as unknown as Db;
  }

  it("processWebhook resolves orgId from connection — an invalid connectionId prevents cross-tenant access (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const mockProjectsTickets = {} as any;
    const svc = new IntegrationsGitService(db, mockProjectsTickets);
    const req = {
      connectionIdRaw: "9999",
      rawBody: "{}",
      signature256: "sha256=abc",
      githubEvent: "push",
    };
    await svc.processWebhook(req as any);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("processWebhook resolves orgId from the connection row — uses owner orgId (control — same-tenant)", async () => {
    const db = makeDb(OWNER);
    (db as any).transaction = jest.fn().mockResolvedValue(undefined);
    const mockProjectsTickets = {} as any;
    const svc = new IntegrationsGitService(db, mockProjectsTickets);
    const req = {
      connectionIdRaw: String(CONN_ID),
      rawBody: "{}",
      signature256: "sha256=abc",
      githubEvent: "push",
    };
    await svc.processWebhook(req as any);
    expect((db as any).transaction).toHaveBeenCalled();
  });
});
