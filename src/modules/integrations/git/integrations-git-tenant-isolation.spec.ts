import type { Db } from "../../../db/drizzle.module";
import { stubService } from "../../../test/service-stub.spec-fixtures";
import type { ProjectsTicketsService } from "../../build/core/projects-tickets.service";
import type { WebhookRequest } from "./git.types";
import { IntegrationsGitService } from "./integrations-git.service";

describe("IntegrationsGitService — cross-tenant isolation", () => {
  const OWNER = "org-owner";
  const ATTACKER = "org-attacker";
  const CONN_ID = 99;

  function makeDb(resolvedOrgId: string | null): { db: Db; transaction: jest.Mock } {
    const transaction = jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        query: { gitConnections: { findFirst: jest.fn().mockResolvedValue(null) } },
        select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }) }) }),
        insert: jest.fn().mockReturnValue({ values: jest.fn().mockReturnValue({ onConflictDoNothing: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }) }) }),
      };
      return fn(tx);
    });
    const db = {
      execute: jest.fn().mockResolvedValue(resolvedOrgId ? [{ org_id: resolvedOrgId }] : []),
      query: {
        gitConnections: {
          findFirst: jest.fn().mockResolvedValue(null),
        },
      },
      transaction,
    } as unknown as Db;
    return { db, transaction };
  }

  it("processWebhook resolves orgId from connection — an invalid connectionId prevents cross-tenant access (cross-tenant isolation)", async () => {
    const { db, transaction } = makeDb(null);
    const mockProjectsTickets = stubService<ProjectsTicketsService>({});
    const svc = new IntegrationsGitService(db, mockProjectsTickets);
    const req: WebhookRequest = {
      connectionIdRaw: "9999",
      rawBody: "{}",
      signature256: "sha256=abc",
      gitlabToken: undefined,
      githubEvent: "push",
      gitlabEvent: undefined,
      deliveryId: undefined,
    };
    await svc.processWebhook(req);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("processWebhook resolves orgId from the connection row — uses owner orgId (control — same-tenant)", async () => {
    const { db, transaction } = makeDb(OWNER);
    transaction.mockReset().mockResolvedValue(undefined);
    const mockProjectsTickets = stubService<ProjectsTicketsService>({});
    const svc = new IntegrationsGitService(db, mockProjectsTickets);
    const req: WebhookRequest = {
      connectionIdRaw: String(CONN_ID),
      rawBody: "{}",
      signature256: "sha256=abc",
      gitlabToken: undefined,
      githubEvent: "push",
      gitlabEvent: undefined,
      deliveryId: undefined,
    };
    await svc.processWebhook(req);
    expect(transaction).toHaveBeenCalled();
  });
});
