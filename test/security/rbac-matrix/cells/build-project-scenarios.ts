import type { Type } from "@nestjs/common";
import { IntakeController, ViewsController } from "src/modules/build/execution/workspace.controller";
import { IntakeService, ViewsService } from "src/modules/build/execution/workspace.service";
import { ModulesController } from "src/modules/build/execution/iterations.controller";
import { ModulesService } from "src/modules/build/execution/modules.service";
import { ProjectsWebhooksController } from "src/modules/build/core";
import { ProjectsCustomFieldsController } from "src/modules/build/core";
import { ProjectsCustomFieldsService, ProjectsWebhooksService } from "src/modules/build/core";
import { createIntakeSchema, createViewSchema } from "src/modules/build/execution/dto/workspace.schemas";
import type { AdapterBinding, ExpectedOutcome, Scenario, ScenarioState } from "../matrix.types";
import { probeHttp, type RealProvider } from "../adapters/http-adapter";
import { projectAccess } from "../adapters/service-adapter";
import {
  customFieldsService,
  intakeService,
  modulesService,
  viewsService,
  webhooksService,
} from "../adapters/real-services";
import { settle } from "../matrix-runner";
import { ORG_A, ORG_B, actorFor, type Standing, type Variant } from "../standings";
import type { WorldDb } from "../world-db";
import { ARCHIVED_PROJECT_A, DELETED_PROJECT_A, PROJECT_A } from "../fixtures";

const VIEWS_LIST = "modules/build/execution/workspace.controller.ts#listViews";

interface ProjectCase {
  readonly id: string;
  readonly standing: Standing;
  readonly variant?: Variant;
  readonly orgId: string;
  readonly projectId: number;
  readonly state: ScenarioState;
  readonly expected: ExpectedOutcome;
  readonly because: string;
}

const PROJECT_CASES: readonly ProjectCase[] = [
  { id: "org-owner", standing: "org:owner", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "the owner reaches its own project and the project is still looked up" },
  { id: "org-admin", standing: "org:admin", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "an org admin resolves the whole catalog including build:manage" },
  { id: "module-owner", standing: "module:owner", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "the build module owner resolves every build key through ownership expansion" },
  { id: "module-admin", standing: "module:admin", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "the build module admin resolves build:manage" },
  { id: "module-member", standing: "module:member", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "allow", because: "a project member reaches the project it belongs to" },
  { id: "org-member", standing: "org:member", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "403", because: "an in-tenant member who is not on the project is forbidden, not told it is missing" },
  { id: "outsider", standing: "outsider", orgId: ORG_A, projectId: PROJECT_A, state: "normal", expected: "403", because: "no live membership resolves no key and no project seat" },
  { id: "org-owner-cross-tenant", standing: "org:owner", orgId: ORG_B, projectId: PROJECT_A, state: "normal", expected: "404", because: "owner standing does not short-circuit the project lookup, so another organisation's project is not found" },
  { id: "module-admin-cross-tenant", standing: "module:admin", orgId: ORG_B, projectId: PROJECT_A, state: "normal", expected: "404", because: "build:manage does not short-circuit the project lookup either" },
  { id: "org-admin-cross-tenant", standing: "org:admin", orgId: ORG_B, projectId: PROJECT_A, state: "normal", expected: "404", because: "org admin standing is confined to its own organisation's projects" },
  { id: "module-owner-cross-tenant", standing: "module:owner", orgId: ORG_B, projectId: PROJECT_A, state: "normal", expected: "404", because: "module ownership in one organisation reaches no project of another" },
  { id: "suspended-member", standing: "module:member", variant: "suspended", orgId: ORG_A, projectId: PROJECT_A, state: "suspended-membership", expected: "403", because: "a suspended membership resolves no keys and its project seat joins only ACTIVE memberships" },
  { id: "removed-member", standing: "module:member", variant: "left", orgId: ORG_A, projectId: PROJECT_A, state: "removed-membership", expected: "403", because: "a membership that LEFT keeps its stale project seat row, which no longer grants anything" },
  { id: "expired-admin", standing: "module:admin", variant: "expired-role", orgId: ORG_A, projectId: PROJECT_A, state: "expired-role", expected: "403", because: "an expired module admin assignment is dropped by the resolver, leaving no build:manage and no seat" },
  { id: "soft-deleted-project", standing: "module:member", orgId: ORG_A, projectId: DELETED_PROJECT_A, state: "soft-deleted-parent", expected: "404", because: "a soft-deleted project is not found even by a member whose seat row survived" },
  { id: "archived-project-member", standing: "module:member", orgId: ORG_A, projectId: ARCHIVED_PROJECT_A, state: "archived-project", expected: "allow", because: "archiving is a lifecycle state, not an authorization one, so a member still reads it" },
  { id: "archived-project-org-member", standing: "org:member", orgId: ORG_A, projectId: ARCHIVED_PROJECT_A, state: "archived-project", expected: "403", because: "archiving widens nothing: a non-member is still forbidden" },
];

const PAIR_OF: Readonly<Record<string, string>> = {
  "org-member": "build-project-access-module-member",
  outsider: "build-project-access-org-owner",
  "org-owner-cross-tenant": "build-project-access-org-owner",
  "module-admin-cross-tenant": "build-project-access-module-admin",
  "org-admin-cross-tenant": "build-project-access-org-admin",
  "module-owner-cross-tenant": "build-project-access-module-owner",
  "suspended-member": "build-project-access-module-member",
  "removed-member": "build-project-access-module-member",
  "expired-admin": "build-project-access-module-admin",
  "soft-deleted-project": "build-project-access-module-member",
  "archived-project-org-member": "build-project-access-archived-project-member",
};

function projectScenarios(world: WorldDb): Scenario[] {
  return PROJECT_CASES.map((item): Scenario => ({
    id: `build-project-access-${item.id}`,
    actor: item.standing,
    resource: "build:project",
    action: "access",
    tenant: item.orgId === ORG_A ? "same" : "other",
    state: item.state,
    expected: item.expected,
    because: item.because,
    pairedWith: PAIR_OF[item.id],
    covers: [VIEWS_LIST],
    bindings: [
      {
        adapter: "service",
        entry: "assertProjectAccess",
        run: () => projectAccess(world, item.standing, item.orgId, item.projectId, item.variant),
      },
      {
        adapter: "http",
        entry: "GET /build/:projectId/views -> ViewsService.listViews",
        run: () =>
          probeHttp(world, {
            controllers: [ViewsController],
            services: [{ provide: ViewsService, useValue: viewsService(world) }],
            verb: "get",
            path: `/build/${item.projectId}/views`,
            permissionKey: "build:view",
            standing: item.standing,
            variant: item.variant,
            orgId: item.orgId,
            serviceReads: "projects",
          }),
      },
    ],
  }));
}

interface Writer {
  readonly id: string;
  readonly path: string;
  readonly key: string;
  readonly covers: string;
  readonly controller: Type<unknown>;
  readonly provider: (world: WorldDb) => RealProvider;
  readonly body: object;
  readonly service?: (world: WorldDb, standing: Standing, orgId: string) => Promise<unknown>;
}

const WRITERS: readonly Writer[] = [
  {
    id: "webhooks",
    path: "webhooks",
    key: "build:manage",
    covers: "modules/build/core/webhooks/projects-webhooks.controller.ts#createWebhook",
    controller: ProjectsWebhooksController,
    provider: (world) => ({ provide: ProjectsWebhooksService, useValue: webhooksService(world) }),
    body: { url: "https://hooks.example.com/build", events: ["ticket.created"] },
  },
  {
    id: "custom-fields",
    path: "custom-fields",
    key: "build:manage",
    covers: "modules/build/core/custom-fields/projects-custom-fields.controller.ts#createField",
    controller: ProjectsCustomFieldsController,
    provider: (world) => ({ provide: ProjectsCustomFieldsService, useValue: customFieldsService(world) }),
    body: { name: "Severity", type: "text" },
  },
  {
    id: "intake",
    path: "intake",
    key: "build:workspace:manage",
    covers: "modules/build/execution/workspace.controller.ts#createIntake",
    controller: IntakeController,
    provider: (world) => ({ provide: IntakeService, useValue: intakeService(world) }),
    body: { title: "Intake", submitterEmail: "intake@example.com" },
    service: (world, standing, orgId) =>
      intakeService(world).createIntake(actorFor(standing, orgId), PROJECT_A, createIntakeSchema.parse({ title: "Intake", submitterEmail: "intake@example.com" })),
  },
  {
    id: "views",
    path: "views",
    key: "build:workspace:manage",
    covers: "modules/build/execution/workspace.controller.ts#createView",
    controller: ViewsController,
    provider: (world) => ({ provide: ViewsService, useValue: viewsService(world) }),
    body: { name: "Board" },
    service: (world, standing, orgId) =>
      viewsService(world).createView(actorFor(standing, orgId), PROJECT_A, createViewSchema.parse({ name: "Board" })),
  },
  {
    id: "modules",
    path: "modules",
    key: "build:workspace:manage",
    covers: "modules/build/execution/iterations.controller.ts#createModule",
    controller: ModulesController,
    provider: (world) => ({ provide: ModulesService, useValue: modulesService(world) }),
    body: { name: "Payments" },
  },
];

const WRITER_CASES: ReadonlyArray<{ readonly suffix: string; readonly standing: Standing; readonly orgId: string; readonly expected: ExpectedOutcome; readonly because: string }> = [
  { suffix: "module-admin", standing: "module:admin", orgId: ORG_A, expected: "allow", because: "the build module admin passes the guard and the service writes into its own project" },
  { suffix: "module-owner", standing: "module:owner", orgId: ORG_A, expected: "allow", because: "the build module owner holds every build key" },
  { suffix: "org-member", standing: "org:member", orgId: ORG_A, expected: "403", because: "a plain member never holds the route's key, so the guard refuses before any write" },
  { suffix: "outsider", standing: "outsider", orgId: ORG_A, expected: "403", because: "no live membership holds no key" },
  { suffix: "cross-tenant", standing: "module:admin", orgId: ORG_B, expected: "404", because: "the service resolves the project in the caller's org before inserting, so a foreign project id is not found" },
];

function writerScenarios(world: WorldDb): Scenario[] {
  return WRITERS.flatMap((writer) =>
    WRITER_CASES.map((item): Scenario => {
      const bindings: AdapterBinding[] = [
        {
          adapter: "http",
          entry: `POST /build/:projectId/${writer.path}`,
          run: () =>
            probeHttp(world, {
              controllers: [writer.controller],
              services: [writer.provider(world)],
              verb: "post",
              path: `/build/${PROJECT_A}/${writer.path}`,
              body: writer.body,
              permissionKey: writer.key,
              standing: item.standing,
              orgId: item.orgId,
              serviceReads: "projects",
            }),
        },
      ];
      const service = writer.service;
      if (service !== undefined)
        bindings.push({
          adapter: "service",
          entry: `${writer.id} service create(actor)`,
          run: () => {
            const mark = world.writes.length;
            return settle(
              () => service(world, item.standing, item.orgId),
              (value) => ({ insertsOnlyWhenAllowed: (value === undefined) === (world.writes.length === mark) }),
            );
          },
        });
      return {
        id: `build-${writer.id}-create-${item.suffix}`,
        actor: item.standing,
        resource: `build:${writer.id}`,
        action: "create",
        tenant: item.orgId === ORG_A ? "same" : "other",
        state: "normal",
        expected: item.expected,
        because: item.because,
        pairedWith: item.expected === "allow" ? undefined : `build-${writer.id}-create-module-admin`,
        covers: [writer.covers],
        bindings,
      };
    }),
  );
}

export function buildProjectScenarios(world: WorldDb): Scenario[] {
  return [...projectScenarios(world), ...writerScenarios(world)];
}
