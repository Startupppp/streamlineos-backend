import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { WebhookEndpointService } from "../../../integrations/core/webhook-endpoint.service";
import {
  MEMBER_STANDING,
  projectAccessRow,
  standingAccess,
  type ProjectAccessRow,
} from "../../__tests__/project-access-doubles";
import { ProjectsWebhooksService } from "./projects-webhooks.service";
import { ProjectsWebhooksDispatchService } from "./projects-webhooks-dispatch.service";

const PROJECT_ID = 7;
const WEBHOOK_ID = 42;

const actor: CurrentUserContext = {
  userId: "user-21",
  orgId: "org-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "s",
  tokenScopes: null,
  principal: humanSessionPrincipal(21, false),
};

const hookRow = {
  id: WEBHOOK_ID,
  orgId: "org-1",
  projectId: PROJECT_ID,
  url: "https://hooks.example.com/build",
  events: ["ticket.created"],
  isActive: true,
  hasSecret: true,
  secretSetAt: null,
  version: 1,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  integrationsEndpointId: null,
};

function makeDb(project: ProjectAccessRow | null) {
  const projectRows = project === null ? [] : [project];
  const rowChain = {
    from: () => rowChain,
    where: () => rowChain,
    orderBy: () => rowChain,
    limit: () => Promise.resolve([hookRow]),
  };
  const select = jest.fn((fields?: object) =>
    fields !== undefined && "memberRole" in fields
      ? { from: () => ({ where: () => ({ limit: () => Promise.resolve(projectRows) }) }) }
      : rowChain,
  );
  const returning = jest.fn(() => Promise.resolve([hookRow]));
  const writeChain = { values: () => ({ returning }), set: () => writeChain, where: () => ({ returning }) };
  const insert = jest.fn(() => writeChain);
  const update = jest.fn(() => writeChain);
  const remove = jest.fn(() => ({ where: () => Promise.resolve([]) }));
  const tx = { select, insert, update, delete: remove };
  const transaction = jest.fn((work: (handle: typeof tx) => Promise<unknown>) => work(tx));
  return { select, insert, update, delete: remove, transaction };
}

async function build(project: ProjectAccessRow | null) {
  const db = makeDb(project);
  const endpoint = {
    createCredential: jest.fn().mockResolvedValue({ id: 5, secretSetAt: new Date(0) }),
    deleteCredential: jest.fn().mockResolvedValue(undefined),
    deliveryStats: jest.fn().mockResolvedValue(new Map()),
    listDeliveries: jest.fn().mockResolvedValue([]),
  };
  const dispatch = { sendTest: jest.fn().mockResolvedValue({ success: true, responseCode: 200 }) };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProjectsWebhooksService,
      { provide: DRIZZLE, useValue: db },
      { provide: WebhookEndpointService, useValue: endpoint },
      { provide: ProjectsWebhooksDispatchService, useValue: dispatch },
      { provide: AccessService, useValue: standingAccess(MEMBER_STANDING) },
    ],
  }).compile();
  return { db, endpoint, dispatch, svc: moduleRef.get(ProjectsWebhooksService) };
}

type Built = Awaited<ReturnType<typeof build>>;

const WRITES: Array<[string, (built: Built) => Promise<unknown>]> = [
  [
    "POST /build/:projectId/webhooks",
    ({ svc }) => svc.createWebhook(actor, PROJECT_ID, { url: "https://hooks.example.com/build", events: ["ticket.created"] }),
  ],
  [
    "PATCH /build/:projectId/webhooks/:webhookId",
    ({ svc }) => svc.updateWebhook(actor, PROJECT_ID, WEBHOOK_ID, { version: 1, isActive: false }),
  ],
  ["DELETE /build/:projectId/webhooks/:webhookId", ({ svc }) => svc.deleteWebhook(actor, PROJECT_ID, WEBHOOK_ID)],
  ["POST /build/:projectId/webhooks/:webhookId/test", ({ svc }) => svc.sendTest(actor, PROJECT_ID, WEBHOOK_ID)],
];

const READS: Array<[string, (built: Built) => Promise<unknown>]> = [
  ["GET /build/:projectId/webhooks", ({ svc }) => svc.listWebhooks(actor, PROJECT_ID)],
  ["GET /build/:projectId/webhooks/:webhookId/deliveries", ({ svc }) => svc.listDeliveries(actor, PROJECT_ID, WEBHOOK_ID)],
];

function acted(built: Built): boolean {
  return (
    built.db.insert.mock.calls.length > 0 ||
    built.db.update.mock.calls.length > 0 ||
    built.db.delete.mock.calls.length > 0 ||
    built.db.transaction.mock.calls.length > 0 ||
    built.dispatch.sendTest.mock.calls.length > 0
  );
}

describe("project webhooks are decided by the project-access rule", () => {
  it.each(WRITES)("%s answers 403 to a same-org member who does not manage the project, before acting", async (_route, call) => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(call(built)).rejects.toThrow(ForbiddenException);
    expect(acted(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 404 for a project outside the caller's organisation", async (_route, call) => {
    const built = await build(null);
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(acted(built)).toBe(false);
  });

  it.each(WRITES)("%s answers 409 PROJECT_LOCKED on a completed project the caller manages", async (_route, call) => {
    const built = await build(projectAccessRow({ manages: true, state: "COMPLETED" }));
    await expect(call(built)).rejects.toThrow(ConflictException);
    expect(acted(built)).toBe(false);
  });

  it.each(WRITES)("%s succeeds for the project's manager", async (_route, call) => {
    const built = await build(projectAccessRow({ manages: true }));
    await call(built);
    expect(acted(built)).toBe(true);
  });

  it.each(READS)("%s conceals a same-org project the caller does not reach as 404", async (_route, call) => {
    const built = await build(projectAccessRow());
    await expect(call(built)).rejects.toThrow(NotFoundException);
    expect(built.endpoint.deliveryStats).not.toHaveBeenCalled();
    expect(built.endpoint.listDeliveries).not.toHaveBeenCalled();
  });

  it.each(READS)("%s answers 404 for a project outside the caller's organisation", async (_route, call) => {
    const built = await build(null);
    await expect(call(built)).rejects.toThrow(NotFoundException);
  });

  it.each(READS)("%s reads for a project member", async (_route, call) => {
    const built = await build(projectAccessRow({ memberRole: "MEMBER" }));
    await expect(call(built)).resolves.toBeDefined();
  });
});
