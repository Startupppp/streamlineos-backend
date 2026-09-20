jest.mock("../core/project-access", () => ({
  assertProjectAccess: jest.fn(),
}));

jest.mock("../../../common/outbox/outbox-writer", () => ({
  OutboxWriter: { emit: jest.fn() },
}));

import { NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";
import { IncidentsService } from "./incidents.service";
import { assertProjectAccess } from "../core/project-access";
import { OutboxWriter } from "../../../common/outbox/outbox-writer";

describe("IncidentsService — cross-tenant isolation", () => {
  const OWNER_ORG = "org-owner";
  const ATTACKER_ORG = "org-attacker";

  const audit = { log: jest.fn() } as never;
  const mockAccess = { resolveUserPermissions: jest.fn() } as unknown as AccessService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(assertProjectAccess).mockResolvedValue(undefined);
    (OutboxWriter.emit as jest.Mock).mockResolvedValue(undefined);
  });

  function makeU(orgId: string): CurrentUserContext {
    return {
      userId: "user-1",
      orgId,
      role: "MEMBER",
      isOrgOwner: false,
      sessionId: "s1",
      tokenScopes: null,
      principal: humanSessionPrincipal(7, false),
    };
  }

  function makeDb(incidentRow: unknown | null = null) {
    const where = jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    return {
      query: {
        projectIncidents: {
          findFirst: jest.fn().mockResolvedValue(incidentRow),
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      select: jest.fn().mockReturnValue({ from }),
    } as unknown as Db;
  }

  it("throws NotFoundException when accessing incident for a different org (cross-tenant isolation)", async () => {
    const db = makeDb(null);
    const svc = new IncidentsService(db, mockAccess, audit);
    await expect(svc.getIncident(makeU(ATTACKER_ORG), 1, 99)).rejects.toThrow(NotFoundException);
  });

  it("returns incident for the owning org (same-tenant control)", async () => {
    const incident = { id: 1, orgId: OWNER_ORG, projectId: 1, title: "Outage" };
    const db = makeDb(incident);
    const svc = new IncidentsService(db, mockAccess, audit);
    const result = await svc.getIncident(makeU(OWNER_ORG), 1, 1);
    expect(result).toMatchObject({ id: 1 });
  });

  it("throws NotFoundException when addUpdate targets a different org's incident", async () => {
    const db = makeDb(null);
    const svc = new IncidentsService(db, mockAccess, audit);
    await expect(
      svc.addUpdate(makeU(ATTACKER_ORG), 1, 99, { message: "Attacker update" }),
    ).rejects.toThrow(NotFoundException);
  });
});
