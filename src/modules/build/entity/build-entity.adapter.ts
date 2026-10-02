import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { AccessService } from "../../access/access.service";
import { holds, type Permissions } from "../../entity-reference/entity-scope";
import {
  type EntityAction,
  type EntityActionResult,
  type EntityActor,
  type EntityAdapter,
  type EntityOption,
  type EntityReference,
  type EntityResolution,
} from "../../entity-reference/entity-reference.types";
import { BuildEntityActions } from "./build-entity.actions";
import { entityProjectReach } from "./build-entity-action-helpers";
import { BuildEntityReadsService, isTicketType, numericId } from "./build-entity-reads.service";

interface AccessPort {
  resolveUserPermissions(orgId: string, userId: string): Promise<Permissions>;
}

const TICKET_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  key: string;
  inputs: EntityAction["inputs"];
}> = [
  {
    id: "status",
    label: "Change status",
    key: "build:tickets:update",
    inputs: [{ name: "status", kind: "choice", required: true }],
  },
  {
    id: "assign",
    label: "Assign",
    key: "build:tickets:assign",
    inputs: [{ name: "assigneeId", kind: "user", required: true }],
  },
  {
    id: "due-date",
    label: "Set due date",
    key: "build:tickets:update",
    inputs: [{ name: "dueDate", kind: "date", required: true }],
  },
];

const PROJECT_ACTIONS: ReadonlyArray<{
  id: string;
  label: string;
  key: string;
  inputs: EntityAction["inputs"];
}> = [
  {
    id: "create-ticket",
    label: "Create ticket",
    key: "build:tickets:create",
    inputs: [
      { name: "title", kind: "text", required: false },
      { name: "type", kind: "choice", required: true, choices: ["TASK", "BUG"] },
    ],
  },
];

@Injectable()
export class BuildEntityAdapter implements EntityAdapter {
  readonly moduleKey = "build";
  readonly types = [
    "ticket",
    "task",
    "project",
    "cycle",
    "release",
    "incident",
  ] as const;
  private readonly reads: BuildEntityReadsService;

  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: AccessPort,
    private readonly actions: BuildEntityActions,
  ) {
    this.reads = new BuildEntityReadsService(db);
  }

  async resolve(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityResolution[]> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    return this.reads.resolveWith(actor, references, permissions);
  }

  async actionsFor(
    actor: EntityActor,
    references: EntityReference[],
  ): Promise<EntityAction[][]> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const resolutions = await this.reads.resolveWith(actor, references, permissions);
    const owningProject = await this.reads.resolveOwningProjectIds(
      actor,
      references,
      resolutions,
    );

    return references.map((reference, index) => {
      if (resolutions[index]?.status !== "resolved") return [];
      const catalog = isTicketType(reference.type)
        ? TICKET_ACTIONS
        : reference.type === "project"
          ? PROJECT_ACTIONS
          : [];
      const projectId = owningProject.get(index);
      return catalog
        .filter((action) => holds(actor, permissions, action.key))
        .map((action) => ({
          id: action.id,
          label: action.label,
          inputs: action.inputs.map((input) =>
            input.kind === "user" && projectId !== undefined
              ? {
                  ...input,
                  options: {
                    from: { type: "project", id: String(projectId) },
                  },
                }
              : input,
          ),
        }));
    });
  }

  async optionsFor(
    actor: EntityActor,
    reference: EntityReference,
  ): Promise<EntityOption[]> {
    if (reference.type !== "project") return [];
    const projectId = numericId(reference);
    if (projectId === null) return [];
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const [resolution] = await this.reads.resolveWith(actor, [reference], permissions);
    if (resolution?.status !== "resolved") return [];
    return this.reads.optionsForProject(actor, projectId);
  }

  async submitAction(
    actor: EntityActor,
    reference: EntityReference,
    actionId: string,
    input: Record<string, unknown>,
  ): Promise<EntityActionResult> {
    const permissions = await this.access.resolveUserPermissions(
      actor.orgId,
      actor.userId,
    );
    const catalog = isTicketType(reference.type)
      ? TICKET_ACTIONS
      : reference.type === "project"
        ? PROJECT_ACTIONS
        : [];
    const action = catalog.find((candidate) => candidate.id === actionId);
    if (!action) return { ok: false, reason: "invalid" };
    if (!holds(actor, permissions, action.key))
      return { ok: false, reason: "forbidden" };

    return this.actions.run(actor, reference, actionId, input, entityProjectReach(actor, permissions));
  }
}
