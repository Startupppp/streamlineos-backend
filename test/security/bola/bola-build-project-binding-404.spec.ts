import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { IntakeService, ViewsService } from "src/modules/build/execution/workspace.service";
import { ModulesService } from "src/modules/build/execution/modules.service";
import { ProjectsCustomFieldsService } from "src/modules/build/core/projects-custom-fields.service";
import { ProjectsWebhooksService } from "src/modules/build/core/projects-webhooks.service";
import { ProjectsMembersService } from "src/modules/build/core/projects-members.service";
import type { Db } from "src/db/drizzle.module";
import type { AccessService } from "src/modules/access/access.service";
import type { CurrentUserContext } from "src/common/auth/backend-claims";

/**
 * The eleven `/build/:projectId/*` routes the live cross-tenant sweep measured as defective.
 *
 * Two distinct defects sat behind them, and both are the same mistake in opposite directions: the
 * READ path of each pair resolved the project and the WRITE path did not, or the standing check
 * short-circuited before the project was ever looked up.
 *
 *   1. `ProjectsMembersService.assertProjectAccess` returned on `u.isOrgOwner` and on
 *      `build:manage` BEFORE resolving the project, so those callers passed the check for a project
 *      id belonging to another organisation and for one belonging to nobody. Nothing crossed — the
 *      reads below still filter on `u.orgId` — but five routes then answered 200 where the contract
 *      requires 404: `/automations`, `/custom-states`, `/labels`, `/members`, `/roster`. Its sibling
 *      `assertCanManageProject`, twenty lines above in the same file, already did the lookup first.
 *
 *   2. `createWebhook`, `createIntake`, `createView`, `createModule` and `createField` inserted with
 *      the `:projectId` straight off the path. Four of them met the composite tenant FK
 *      `(org_id, project_id)` and raised an uncaught **23503 — a 500 that is itself an existence
 *      oracle**; `createField` writes to a table with no such FK, so the row simply LANDED under the
 *      caller's organisation carrying another organisation's project id, and answered 201.
 *
 * Every test here asserts the refusal class, not just the status: a `ForbiddenException` on another
 * organisation's id confirms the record exists and is the finding this ticket exists to forbid.
 */

const CALLER_ORG = "org-b-caller";
const CALLER_USER = "user-b";
const FOREIGN_PROJECT_ID = 4242;

/** A `Db` whose `projects.findFirst` answers with `row` — `undefined` is the cross-tenant case. */
function dbSeeing(row: { id: number; managerMembershipId?: number | null } | undefined): {
  db: Db;
  writes: () => number;
  lookups: () => number;
} {
  const state = { writes: 0, lookups: 0 };
  const db = {
    query: {
      projects: {
        findFirst: jest.fn().mockImplementation(() => {
          state.lookups += 1;
          return Promise.resolve(row);
        }),
      },
    },
    insert: jest.fn().mockImplementation(() => {
      state.writes += 1;
      return { values: () => ({ returning: () => Promise.resolve([{ id: 1 }]) }) };
    }),
    select: jest.fn().mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
    })),
  } as unknown as Db;
  return { db, writes: () => state.writes, lookups: () => state.lookups };
}

const OWNER: CurrentUserContext = {
  userId: CALLER_USER,
  orgId: CALLER_ORG,
  isOrgOwner: true,
} as unknown as CurrentUserContext;

function members(db: Db): ProjectsMembersService {
  const access = { resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()) } as unknown as AccessService;
  return new ProjectsMembersService(
    db,
    {} as never,
    access,
    {} as never,
    {} as never,
  );
}

describe("BOLA probe — the standing check that skipped the project it was standing over", () => {
  it("CROSS-TENANT-MISS: an org owner is refused a project their organisation does not hold", async () => {
    const seen = dbSeeing(undefined);
    await expect(members(seen.db).assertProjectAccess(OWNER, FOREIGN_PROJECT_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it("THE-LOOKUP-HAPPENS: the project is resolved even for a caller who would short-circuit", async () => {
    const seen = dbSeeing({ id: FOREIGN_PROJECT_ID, managerMembershipId: null });
    await members(seen.db).assertProjectAccess(OWNER, FOREIGN_PROJECT_ID);
    expect(seen.lookups()).toBeGreaterThan(0);
  });

  it("EXISTENCE-ORACLE-GUARD: the refusal is NotFound, never Forbidden", async () => {
    const seen = dbSeeing(undefined);
    const thrown = await members(seen.db)
      .assertProjectAccess(OWNER, FOREIGN_PROJECT_ID)
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).not.toBeInstanceOf(ForbiddenException);
  });

  it("SAME-TENANT: the caller's own project is still served", async () => {
    const seen = dbSeeing({ id: FOREIGN_PROJECT_ID, managerMembershipId: null });
    await expect(members(seen.db).assertProjectAccess(OWNER, FOREIGN_PROJECT_ID)).resolves.toBeUndefined();
  });
});

describe("BOLA probe — the five writes that never resolved the project they wrote into", () => {
  const writers: readonly {
    readonly route: string;
    readonly run: (db: Db) => Promise<unknown>;
  }[] = [
    {
      route: "POST /build/:projectId/webhooks",
      run: (db) =>
        new ProjectsWebhooksService(db).createWebhook(CALLER_ORG, FOREIGN_PROJECT_ID, CALLER_USER, {
          url: "https://example.invalid/hook",
          events: ["ticket.created"],
        } as unknown as Parameters<ProjectsWebhooksService["createWebhook"]>[3]),
    },
    {
      route: "POST /build/:projectId/custom-fields",
      run: (db) =>
        new ProjectsCustomFieldsService(db).createField(CALLER_ORG, FOREIGN_PROJECT_ID, {
          name: "n",
          type: "text",
        } as unknown as Parameters<ProjectsCustomFieldsService["createField"]>[2]),
    },
    {
      route: "POST /build/:projectId/intake",
      run: (db) =>
        new IntakeService(db).createIntake(CALLER_ORG, FOREIGN_PROJECT_ID, {
          title: "t",
          source: "FORM",
          submitterEmail: "a@example.invalid",
        } as unknown as Parameters<IntakeService["createIntake"]>[2]),
    },
    {
      route: "POST /build/:projectId/views",
      run: (db) =>
        new ViewsService(db).createView(CALLER_ORG, CALLER_USER, FOREIGN_PROJECT_ID, {
          name: "n",
        } as unknown as Parameters<ViewsService["createView"]>[3]),
    },
    {
      route: "POST /build/:projectId/modules",
      run: (db) =>
        new ModulesService(db).createModule(CALLER_ORG, CALLER_USER, FOREIGN_PROJECT_ID, {
          name: "n",
        } as unknown as Parameters<ModulesService["createModule"]>[3]),
    },
  ];

  for (const writer of writers) {
    it(`CROSS-TENANT-MISS: ${writer.route} refuses another organisation's project id`, async () => {
      const seen = dbSeeing(undefined);
      const thrown = await writer.run(seen.db).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(NotFoundException);
      expect(thrown).not.toBeInstanceOf(ForbiddenException);
    });

    it(`NO-WRITE-ON-MISS: ${writer.route} inserts nothing, so no FK is asked to refuse it`, async () => {
      const seen = dbSeeing(undefined);
      await writer.run(seen.db).catch(() => undefined);
      expect(seen.writes()).toEqual(0);
    });
  }
});
