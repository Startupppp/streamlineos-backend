import { FilesController } from "src/modules/build/files/files.controller";
import { MilestonesController } from "src/modules/build/execution/workspace.controller";
import { MilestonesService } from "src/modules/build/execution/workspace.service";
import { ProjectsTicketAssociationsController } from "src/modules/build/core/tickets";
import { ProjectsTicketLinksService } from "src/modules/build/core/tickets";
import type { ExpectedOutcome, Scenario, ScenarioState } from "../matrix.types";
import { probeHttp } from "../adapters/http-adapter";
import { milestoneLifecycle, ticketRead } from "../adapters/service-adapter";
import { milestonesService, ticketLinksService } from "../adapters/real-services";
import { downloadKey, signThenDownload } from "../adapters/file-adapter";
import { ORG_A, ORG_B, type Standing, type Variant } from "../standings";
import type { WorldDb } from "../world-db";
import {
  ARCHIVED_PROJECT_A,
  ARCHIVED_TICKET_A,
  DELETED_MILESTONE_A,
  DELETED_PARENT_TICKET_A,
  DELETED_PROJECT_A,
  FILE_A,
  MILESTONE_A,
  ORPHANED_MILESTONE_A,
  PROJECT_A,
  SIBLING_PROJECT_A,
  TICKET_A,
} from "../fixtures";

interface TicketCase {
  readonly id: string;
  readonly standing: Standing;
  readonly variant?: Variant;
  readonly orgId: string;
  readonly projectId: number;
  readonly ticketId: number;
  readonly state: ScenarioState;
  readonly expected: ExpectedOutcome;
  readonly because: string;
  readonly pairedWith?: string;
}

const TICKET_ALLOW = "build-ticket-read-module-member";

const TICKET_CASES: readonly TicketCase[] = [
  { id: "module-member", standing: "module:member", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "allow", because: "a project member reads a ticket nested under its own project" },
  { id: "org-owner", standing: "org:owner", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "allow", because: "the owner reads every ticket of its own organisation" },
  { id: "module-admin", standing: "module:admin", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "allow", because: "the module admin resolves build:manage and an all tickets scope" },
  { id: "org-member", standing: "org:member", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "403", because: "a member outside the project and without a tickets scope is forbidden", pairedWith: TICKET_ALLOW },
  { id: "outsider", standing: "outsider", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "403", because: "no live membership resolves no tickets scope", pairedWith: TICKET_ALLOW },
  { id: "cross-project", standing: "module:member", orgId: ORG_A, projectId: SIBLING_PROJECT_A, ticketId: TICKET_A, state: "cross-project", expected: "404", because: "a ticket addressed through a sibling project is bound to its parent and is not found", pairedWith: TICKET_ALLOW },
  { id: "cross-tenant", standing: "module:member", orgId: ORG_B, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "404", because: "another organisation's ticket id is not found", pairedWith: TICKET_ALLOW },
  { id: "org-admin", standing: "org:admin", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "allow", because: "an org admin resolves the whole catalog and an all tickets scope" },
  { id: "module-owner", standing: "module:owner", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "allow", because: "the build module owner resolves build:manage through ownership" },
  { id: "org-admin-cross-tenant", standing: "org:admin", orgId: ORG_B, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "404", because: "org admin standing reaches no ticket of another organisation", pairedWith: "build-ticket-read-org-admin" },
  { id: "module-owner-cross-tenant", standing: "module:owner", orgId: ORG_B, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "404", because: "module ownership reaches no ticket of another organisation", pairedWith: "build-ticket-read-module-owner" },
  { id: "owner-cross-tenant", standing: "org:owner", orgId: ORG_B, projectId: PROJECT_A, ticketId: TICKET_A, state: "normal", expected: "404", because: "owner standing in one organisation reaches nothing in another", pairedWith: "build-ticket-read-org-owner" },
  { id: "suspended-member", standing: "module:member", variant: "suspended", orgId: ORG_A, projectId: PROJECT_A, ticketId: TICKET_A, state: "suspended-membership", expected: "403", because: "a suspended member resolves no tickets scope", pairedWith: TICKET_ALLOW },
  { id: "soft-deleted-project", standing: "module:member", orgId: ORG_A, projectId: DELETED_PROJECT_A, ticketId: DELETED_PARENT_TICKET_A, state: "soft-deleted-parent", expected: "404", because: "a live ticket under a soft-deleted project is not found because its parent is not", pairedWith: TICKET_ALLOW },
  { id: "archived-project", standing: "module:member", orgId: ORG_A, projectId: ARCHIVED_PROJECT_A, ticketId: ARCHIVED_TICKET_A, state: "archived-project", expected: "allow", because: "an archived project's tickets stay readable to its members" },
];

function ticketScenarios(world: WorldDb): Scenario[] {
  const reads = TICKET_CASES.map((item): Scenario => ({
    id: `build-ticket-read-${item.id}`,
    actor: item.standing,
    resource: "build:ticket",
    action: "read",
    tenant: item.orgId === ORG_A ? "same" : "other",
    state: item.state,
    expected: item.expected,
    because: item.because,
    pairedWith: item.pairedWith,
    covers: ["modules/build/core/tickets/projects-ticket-associations.controller.ts#getGitLinks"],
    bindings: [
      {
        adapter: "service",
        entry: "assertTicketReadAccess",
        run: () => ticketRead(world, item.standing, item.orgId, item.projectId, item.ticketId, item.variant),
      },
      {
        adapter: "http",
        entry: "GET /build/:projectId/tickets/:ticketId/git-links -> ProjectsTicketLinksService.getGitLinks",
        run: () =>
          probeHttp(world, {
            controllers: [ProjectsTicketAssociationsController],
            services: [{ provide: ProjectsTicketLinksService, useValue: ticketLinksService(world) }],
            verb: "get",
            path: `/build/${item.projectId}/tickets/${item.ticketId}/git-links`,
            permissionKey: "build:tickets:view",
            standing: item.standing,
            variant: item.variant,
            orgId: item.orgId,
            serviceReads: "tickets",
          }),
      },
    ],
  }));
  return [
    ...reads,
    {
      id: "build-ticket-read-module-disabled",
      actor: "module:member",
      resource: "build:ticket",
      action: "read",
      tenant: "same",
      state: "module-disabled",
      expected: "402",
      because: "ModuleGuard refuses a disabled module with 402 before the permission or the service is reached",
      pairedWith: TICKET_ALLOW,
      bindings: [
        {
          adapter: "http",
          entry: "GET /build/:projectId/tickets/:ticketId/git-links",
          run: () =>
            probeHttp(world, {
              controllers: [ProjectsTicketAssociationsController],
              services: [{ provide: ProjectsTicketLinksService, useValue: ticketLinksService(world) }],
              verb: "get",
              path: `/build/${PROJECT_A}/tickets/${TICKET_A}/git-links`,
              permissionKey: "build:tickets:view",
              standing: "module:member",
              orgId: ORG_A,
              moduleDisabled: true,
            }),
        },
      ],
    },
  ];
}

const MILESTONE_CASES: ReadonlyArray<{ readonly suffix: string; readonly standing: Standing; readonly orgId: string; readonly projectId: number; readonly state: ScenarioState; readonly expected: ExpectedOutcome; readonly because: string }> = [
  { suffix: "module-admin", standing: "module:admin", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "the module admin holds the workspace keys and reaches the project" },
  { suffix: "org-owner", standing: "org:owner", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "the owner holds every key and reaches every project of its organisation" },
  { suffix: "org-member", standing: "org:member", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "403", because: "an in-tenant member outside the project holds neither the key nor a seat" },
  { suffix: "cross-tenant", standing: "module:admin", orgId: ORG_B, projectId: PROJECT_A, state: "normal", expected: "404", because: "another organisation's project is not found, so its milestone is untouched" },
  { suffix: "soft-deleted-project", standing: "module:admin", orgId: ORG_A, projectId: DELETED_PROJECT_A, state: "soft-deleted-parent", expected: "404", because: "a live milestone under a soft-deleted project is not found" },
];

function milestoneScenarios(world: WorldDb): Scenario[] {
  const verbs: ReadonlyArray<{ readonly verb: "delete" | "restore"; readonly key: string; readonly method: string }> = [
    { verb: "delete", key: "build:workspace:manage", method: "deleteMilestone" },
    { verb: "restore", key: "build:workspace:restore", method: "restoreMilestone" },
  ];
  return verbs.flatMap(({ verb, key, method }) =>
    MILESTONE_CASES.map((item): Scenario => {
      const milestoneId =
        item.projectId === DELETED_PROJECT_A ? ORPHANED_MILESTONE_A : verb === "delete" ? MILESTONE_A : DELETED_MILESTONE_A;
      return {
        id: `build-milestone-${verb}-${item.suffix}`,
        actor: item.standing,
        resource: "build:milestone",
        action: verb,
        tenant: item.orgId === ORG_A ? "same" : "other",
        state: item.state,
        expected: item.expected,
        because: item.because,
        pairedWith: item.expected === "allow" ? undefined : `build-milestone-${verb}-module-admin`,
        covers: [`modules/build/execution/workspace.controller.ts#${method}`],
        bindings: [
          {
            adapter: "service",
            entry: `MilestonesService.${method}`,
            run: () => milestoneLifecycle(world, verb, item.standing, item.orgId, item.projectId, milestoneId),
          },
          {
            adapter: "http",
            entry: verb === "delete" ? "DELETE /build/:projectId/milestones/:milestoneId" : "POST /build/:projectId/milestones/:milestoneId/restore",
            run: () =>
              probeHttp(world, {
                controllers: [MilestonesController],
                services: [{ provide: MilestonesService, useValue: milestonesService(world) }],
                verb: verb === "delete" ? "delete" : "post",
                path: verb === "delete" ? `/build/${item.projectId}/milestones/${milestoneId}` : `/build/${item.projectId}/milestones/${milestoneId}/restore`,
                permissionKey: key,
                standing: item.standing,
                orgId: item.orgId,
                serviceReads: "projects",
              }),
          },
        ],
      };
    }),
  );
}

function fileScenarios(world: WorldDb): Scenario[] {
  const list = (standing: Standing, moduleDisabled: boolean) => () =>
    probeHttp(world, {
      controllers: [FilesController],
      verb: "get",
      path: `/build/${PROJECT_A}/files`,
      permissionKey: "build:files:view",
      standing,
      orgId: ORG_A,
      moduleDisabled,
    });
  const listing = (id: string, standing: Standing, state: ScenarioState, expected: ExpectedOutcome, because: string, pairedWith?: string): Scenario => ({
    id,
    actor: standing,
    resource: "build:files",
    action: "list",
    tenant: "same",
    state,
    expected,
    because,
    pairedWith,
    covers: ["modules/build/files/files.controller.ts#listFiles"],
    bindings: [{ adapter: "http", entry: "GET /build/:projectId/files (guards only; service not wired)", run: list(standing, state === "module-disabled") }],
  });
  const signed = (id: string, standing: Standing, orgId: string, projectId: number, tenant: "same" | "other", state: ScenarioState, expected: ExpectedOutcome, because: string, pairedWith?: string): Scenario => ({
    id,
    actor: standing,
    resource: "build:file",
    action: "sign-and-download",
    tenant,
    state,
    expected,
    because,
    pairedWith,
    covers: ["modules/build/files/files.controller.ts#getSignedUrl"],
    bindings: [
      {
        adapter: "file",
        entry: "GET /build/:projectId/files/:fileId/url then GET /storage/download?key",
        run: () => signThenDownload(world, standing, orgId, projectId, FILE_A),
      },
    ],
  });
  const ownKey = `${ORG_A}/files/${FILE_A}.pdf`;
  return [
    listing("build-files-list-module-admin", "module:admin", "normal", "allow", "the module admin holds build:files:view"),
    listing("build-files-list-org-owner", "org:owner", "normal", "allow", "the owner holds every catalog key"),
    listing("build-files-list-module-member", "module:member", "normal", "allow", "the member rung holds view keys"),
    listing("build-files-list-org-member", "org:member", "normal", "403", "a plain member never resolves build:files:view", "build-files-list-module-member"),
    listing("build-files-list-module-disabled", "module:admin", "module-disabled", "402", "a disabled module is a plan answer, not a permission answer", "build-files-list-module-admin"),
    listing("build-files-list-owner-module-disabled", "org:owner", "module-disabled", "402", "owner standing does not bypass the module gate", "build-files-list-org-owner"),
    signed("file-sign-download-module-admin", "module:admin", ORG_A, PROJECT_A, "same", "normal", "allow", "the caller's own file is signed under its own org prefix and the download route verifies the same key"),
    signed("file-sign-download-org-owner", "org:owner", ORG_A, PROJECT_A, "same", "normal", "allow", "the owner signs and downloads its own organisation's file"),
    signed("file-sign-download-org-member", "org:member", ORG_A, PROJECT_A, "same", "normal", "403", "a plain member never holds build:files:view, so nothing is signed", "file-sign-download-module-admin"),
    signed("file-sign-download-cross-tenant", "module:admin", ORG_B, PROJECT_A, "other", "normal", "404", "another organisation's project is not found, so no URL is ever signed", "file-sign-download-module-admin"),
    signed("file-sign-download-cross-project", "module:admin", ORG_A, SIBLING_PROJECT_A, "same", "cross-project", "404", "a file addressed through a sibling project is bound to its parent and is not found", "file-sign-download-module-admin"),
    {
      id: "storage-download-own-key",
      actor: "org:member",
      resource: "storage:object",
      action: "download",
      tenant: "same",
      state: "normal",
      expected: "allow",
      because: "assertKeyReadable admits a generic key under the caller's own organisation",
      bindings: [{ adapter: "file", entry: "GET /storage/download?key -> assertKeyReadable", run: () => downloadKey(world, "org:member", ORG_A, ownKey) }],
    },
    {
      id: "storage-download-foreign-key",
      actor: "org:member",
      resource: "storage:object",
      action: "download",
      tenant: "other",
      state: "normal",
      expected: "404",
      because: "a key naming another organisation is refused before any lookup and nothing is signed",
      pairedWith: "storage-download-own-key",
      bindings: [{ adapter: "file", entry: "GET /storage/download?key -> assertKeyReadable", run: () => downloadKey(world, "org:member", ORG_B, ownKey) }],
    },
  ];
}

export function buildWorkScenarios(world: WorldDb): Scenario[] {
  return [...ticketScenarios(world), ...milestoneScenarios(world), ...fileScenarios(world)];
}
