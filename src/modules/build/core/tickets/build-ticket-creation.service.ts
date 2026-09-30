import { Inject, Injectable } from "@nestjs/common";
import { ticketActivityLog, tickets } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.module";
import type { TenantTx } from "../../../../common/tenant";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { allocateTicketNumbers } from "../lib/allocate-ticket-number";
import { reserveTicketCapacity } from "../lib/build-ticket-capacity";

export type BuildTicketDraft = Omit<
  typeof tickets.$inferInsert,
  "id" | "orgId" | "projectId" | "ticketNumber" | "createdAt" | "updatedAt"
> & {
  automationAssigneeUserId?: string | null;
  activityToValue?: string | null;
};

export type BuildTicketCreation = {
  orgId: string;
  projectId: number;
  actor: {
    userId: string | null;
    membershipId: number | null;
    systemActor?: string;
  };
  drafts: readonly BuildTicketDraft[];
};

export type CreatedBuildTickets = {
  command: BuildTicketCreation;
  tickets: (typeof tickets.$inferSelect)[];
};

@Injectable()
export class BuildTicketCreationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly webhooks: ProjectsWebhooksDispatchService,
    private readonly automations: BuildAutomationRunnerService,
    private readonly cache: CacheService,
  ) {}

  async create(command: BuildTicketCreation): Promise<CreatedBuildTickets> {
    const created = await this.db.transaction((tx) => this.createInTransaction(tx, command));
    this.publish(created);
    return created;
  }

  async createInTransaction(
    tx: TenantTx,
    command: BuildTicketCreation,
  ): Promise<CreatedBuildTickets> {
    if (command.drafts.length === 0) return { command, tickets: [] };

    await reserveTicketCapacity(
      tx,
      command.orgId,
      command.projectId,
      command.drafts.map((draft) => ({ status: draft.status ?? "TODO", count: 1 })),
    );
    const startNumber = await allocateTicketNumbers(
      tx,
      command.orgId,
      command.projectId,
      command.drafts.length,
    );
    const metadata = command.drafts.map((draft) => ({
      automationAssigneeUserId: draft.automationAssigneeUserId ?? null,
      activityToValue: draft.activityToValue ?? null,
    }));
    const rows = command.drafts.map((draft, index) => {
      const { automationAssigneeUserId: _assignee, activityToValue: _activity, ...values } = draft;
      return {
        ...values,
        orgId: command.orgId,
        projectId: command.projectId,
        ticketNumber: startNumber + index,
      };
    });
    const created = await tx.insert(tickets).values(rows).returning();

    await tx.insert(ticketActivityLog).values(
      created.map((ticket, index) => ({
        orgId: command.orgId,
        ticketId: ticket.id,
        projectId: command.projectId,
        userMembershipId: command.actor.membershipId,
        action: "created" as const,
        toValue: metadata[index]?.activityToValue ?? null,
      })),
    );

    const actor = command.actor.userId ?? command.actor.systemActor ?? "system";
    const timestamp = new Date().toISOString();
    for (const ticket of created)
      await this.webhooks.enqueue(tx, command.orgId, command.projectId, "ticket.created", {
        id: ticket.id,
        projectId: command.projectId,
        title: ticket.title,
        status: ticket.status,
        type: ticket.type,
        priority: ticket.priority,
        assigneeMembershipId: ticket.assigneeMembershipId ?? null,
        actor,
        timestamp,
      });

    return { command, tickets: created };
  }

  publish(created: CreatedBuildTickets): void {
    for (const [index, ticket] of created.tickets.entries()) {
      const draft = created.command.drafts[index];
      this.automations.runForTicketEvent(
        created.command.orgId,
        created.command.projectId,
        "ticket.created",
        {
          ticketId: ticket.id,
          projectId: created.command.projectId,
          orgId: created.command.orgId,
          title: ticket.title,
          status: ticket.status,
          priority: ticket.priority,
          assigneeId: draft?.automationAssigneeUserId ?? null,
          type: ticket.type,
        },
      );
    }

    void this.cache
      .invalidateNamespace(`build:analytics:${created.command.orgId}`)
      .catch(
        logSideEffectFailure("analytics cache eviction", {
          orgId: created.command.orgId,
          projectId: created.command.projectId,
        }),
      );
  }
}
