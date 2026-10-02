jest.mock("../core", () => ({
  assertProjectAccess: jest.fn(),
  assertProjectWriteAccess: jest.fn(),
}));

import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { AuditService } from "../../../common/audit/audit.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { AccessService } from "../../access/access.service";
import { IncidentsService } from "./incidents.service";

const ORG = "org-1";
const MEMBER = "user-in-org";
const OUTSIDER = "user-elsewhere";

const actor: CurrentUserContext = {
  orgId: ORG,
  userId: "user-1",
  role: "MEMBER",
  isOrgOwner: false,
  sessionId: "session",
  tokenScopes: null,
  principal: humanSessionPrincipal(7, false),
};

function incidentsDb() {
  const membershipWhere = jest.fn(async () => [{ userId: MEMBER }]);
  const inserted = jest.fn(async () => [{ id: 9, ownerId: MEMBER }]);
  const updated = jest.fn(async () => [{ id: 9, ownerId: MEMBER }]);
  const tx = {
    execute: jest.fn(async () => undefined),
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: jest.fn(async () => [{ maxNum: 0 }]) })) })),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: inserted })) })),
  };
  return {
    query: { projectIncidents: { findFirst: jest.fn(async () => ({ id: 1, orgId: ORG, projectId: 1 })) } },
    select: jest.fn(() => ({ from: jest.fn(() => ({ where: membershipWhere })) })),
    insert: jest.fn(() => ({ values: jest.fn(() => ({ returning: inserted })) })),
    update: jest.fn(() => ({ set: jest.fn(() => ({ where: jest.fn(() => ({ returning: updated })) })) })),
    transaction: jest.fn(async (run: (handle: typeof tx) => unknown) => run(tx)),
    inserted,
    updated,
  };
}

async function incidentsService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      IncidentsService,
      { provide: DRIZZLE, useValue: db },
      { provide: AccessService, useValue: {} },
      { provide: AuditService, useValue: { log: jest.fn() } },
    ],
  }).compile();
  return moduleRef.get(IncidentsService);
}

describe("IncidentsService — an owner must be an active member of the caller's org", () => {
  it("refuses a follow-up action owned by a user outside the org with 404, writing nothing", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(
      svc.addFollowUpAction(actor, 1, 1, { title: "Rotate keys", ownerId: OUTSIDER }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("adds a follow-up action owned by a member of the org", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(
      svc.addFollowUpAction(actor, 1, 1, { title: "Rotate keys", ownerId: MEMBER }),
    ).resolves.toMatchObject({ ownerId: MEMBER });
  });

  it("refuses reassigning a follow-up action to a user outside the org with 404, updating nothing", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(svc.updateFollowUpAction(actor, 1, 1, 9, { ownerId: OUTSIDER })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("reassigns a follow-up action to a member of the org, and clearing the owner needs no lookup", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(svc.updateFollowUpAction(actor, 1, 1, 9, { ownerId: MEMBER })).resolves.toMatchObject({ ownerId: MEMBER });
    await expect(svc.updateFollowUpAction(actor, 1, 1, 9, { ownerId: null })).resolves.toMatchObject({ id: 9 });
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("refuses an incident owned by a user outside the org with 404 before the numbering transaction", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(svc.createIncident(actor, 1, { title: "Outage", ownerId: OUTSIDER })).rejects.toBeInstanceOf(NotFoundException);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("creates an incident owned by a member of the org", async () => {
    const db = incidentsDb();
    const svc = await incidentsService(db);

    await expect(svc.createIncident(actor, 1, { title: "Outage", ownerId: MEMBER })).resolves.toMatchObject({ id: 9 });
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });
});
