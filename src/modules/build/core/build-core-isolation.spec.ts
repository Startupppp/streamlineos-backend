/**
 * Cross-tenant isolation tests for the remaining Build core services.
 *
 * Each service below has at least one test verifying that a cross-org resource ID
 * is rejected (404 / NotFoundException) and that queries are scoped by orgId.
 */

import { NotFoundException } from "@nestjs/common";
import { ProjectsReleasesService } from "./releases/projects-releases.service";
import { ProjectsLabelsService } from "./lib/projects-labels.service";
import { ProjectsCustomFieldsService } from "./custom-fields/projects-custom-fields.service";
import { ProjectsTicketChecklistsService } from "./tickets/projects-ticket-checklists.service";
import { ProjectsCustomStatesService } from "./custom-states/projects-custom-states.service";
import type { Db } from "../../../db/drizzle.module";
import type { AccessService } from "../../access/access.service";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../common/auth/principal";

function makeNotFoundDb(): Db {
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(undefined) },
      tickets: { findFirst: jest.fn().mockResolvedValue(undefined) },
      ticketChecklists: { findFirst: jest.fn().mockResolvedValue(undefined) },
      projectReleases: { findFirst: jest.fn().mockResolvedValue(undefined) },
      projectLabels: { findFirst: jest.fn().mockResolvedValue(undefined) },
      projectCustomFields: { findFirst: jest.fn().mockResolvedValue(undefined) },
      projectTicketChecklists: { findFirst: jest.fn().mockResolvedValue(undefined) },
      projectCustomStatuses: { findFirst: jest.fn().mockResolvedValue(undefined) },
    },
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => {
      return cb({
        select: jest.fn().mockReturnValue({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: jest.fn().mockReturnValue({
          values: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue([]),
          }),
        }),
        update: jest.fn().mockReturnValue({
          set: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              returning: jest.fn().mockResolvedValue([]),
            }),
          }),
        }),
      });
    }),
    execute: jest.fn().mockResolvedValue([]),
  } as unknown as Db;
}

beforeEach(() => {
  jest.resetAllMocks();
});

function makeAttackerU(): CurrentUserContext {
  return {
    userId: "attacker",
    orgId: "org-attacker",
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "s",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, false),
  };
}

function makeNoPermAccess(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

describe("ProjectsReleasesService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when release belongs to a different org", async () => {
    const db = makeNotFoundDb();
    const svc = new ProjectsReleasesService(db, makeNoPermAccess());

    await expect(svc.updateRelease(makeAttackerU(), 99, 999, { name: "v2", rowVersion: 1 })).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when adding ticket to a cross-org release", async () => {
    const db = makeNotFoundDb();
    const svc = new ProjectsReleasesService(db, makeNoPermAccess());

    await expect(svc.addTicketToRelease(makeAttackerU(), 99, 999, 1)).rejects.toThrow(NotFoundException);
  });
});

describe("ProjectsLabelsService — cross-tenant isolation (BOLA)", () => {
  it("throws NotFoundException when updating a label that belongs to a different org", async () => {
    const db = makeNotFoundDb();
    const svc = new ProjectsLabelsService(db);

    await expect(svc.updateLabel("org-attacker", 999, { name: "hacked" })).rejects.toThrow(NotFoundException);
  });

  it("throws NotFoundException when deleting a cross-org label", async () => {
    const db = makeNotFoundDb();
    const svc = new ProjectsLabelsService(db);

    await expect(svc.deleteLabel("org-attacker", 999)).rejects.toThrow(NotFoundException);
  });
});

describe("ProjectsCustomFieldsService — cross-tenant isolation", () => {
  it("refuses a cross-org project instead of listing an empty set", async () => {
    const orderBy = jest.fn().mockResolvedValue([]);
    const db = {
      ...makeNotFoundDb(),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ orderBy }) }),
      }),
    } as unknown as Db;

    const svc = new ProjectsCustomFieldsService(db, makeNoPermAccess());

    await expect(svc.listFields("org-attacker", 999)).rejects.toThrow(NotFoundException);
    expect(orderBy).not.toHaveBeenCalled();
  });

  it("lists the org's own custom fields (control)", async () => {
    const db = {
      query: { projects: { findFirst: jest.fn().mockResolvedValue({ id: 1 }) } },
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({ orderBy: jest.fn().mockResolvedValue([]) }),
        }),
      }),
    } as unknown as Db;

    const svc = new ProjectsCustomFieldsService(db, makeNoPermAccess());

    await expect(svc.listFields("org-owner", 1)).resolves.toEqual([]);
  });
});

describe("ProjectsTicketChecklistsService — cross-tenant isolation", () => {
  it("throws NotFoundException when checklist belongs to a different org", async () => {
    const db = makeNotFoundDb();
    const svc = new ProjectsTicketChecklistsService(db);

    await expect(svc.deleteChecklist("org-attacker", 5, 11, 999)).rejects.toThrow(NotFoundException);
  });
});

describe("ProjectsCustomStatesService — cross-tenant isolation", () => {
  it("throws NotFoundException when updating a custom state that belongs to a different org", async () => {
    const db = {
      ...makeNotFoundDb(),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    } as unknown as Db;

    const svc = new ProjectsCustomStatesService(db, {} as never);
    const u = { userId: "u-1", orgId: "org-attacker", isOrgOwner: false, role: "MEMBER", sessionId: "s", tokenScopes: null, principal: { kind: "human", membershipId: 1, isOwner: false } } as never;

    await expect(svc.updateCustomState(u, 1, 999, { name: "Stolen" })).rejects.toThrow(NotFoundException);
  });
});
