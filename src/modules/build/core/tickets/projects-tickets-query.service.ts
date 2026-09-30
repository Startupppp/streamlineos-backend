import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { Db } from "../../../../db/drizzle.types";
import { CacheService } from "../../../../common/cache/cache.service";
import { logSideEffectFailure } from "../../../../common/logger/side-effect";
import { AccessService } from "../../../access/access.service";
import { resolveValidTicketStatuses } from "./ticket-status.util";
import { ProjectsInvalidTicketStatusException } from "../../../../common/http/api-exceptions";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { BulkUpdateInput, RankTicketInput } from "../dto/projects.schemas";
import { rankTicket } from "./projects-tickets-rank-utils";
import { bulkMutateTickets } from "./build-ticket-bulk-mutation";
import { authorizeTicketMutation, lockProjectTicketMutation, readMutationTickets } from "../project-crud/project-access";
import { ProjectsWebhooksDispatchService } from "../webhooks/projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";

@Injectable()
export class ProjectsTicketsQueryService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly cache: CacheService,
    private readonly access: AccessService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly automationRunner: BuildAutomationRunnerService,
    private readonly activity: ProjectsActivityService,
    private readonly dispatch: NotificationDispatchService,
    private readonly transfer: ProjectsTicketsTransferService,
  ) {}

  async validateTicketStatus(projectId: number, orgId: string, status: string): Promise<void> {
    const valid = await resolveValidTicketStatuses(this.db, projectId, orgId);
    if (!valid.has(status)) throw new ProjectsInvalidTicketStatusException(status);
  }

  async bulkUpdate(actor: CurrentUserContext, projectId: number, body: BulkUpdateInput) {
    const result = await bulkMutateTickets(this.db, this.access, actor, projectId, body, {
      webhooksDispatch: this.webhooksDispatch,
      automationRunner: this.automationRunner,
      activity: this.activity,
      dispatch: this.dispatch,
      transfer: this.transfer,
    });
    await this.cache.invalidateNamespace(`build:analytics:${actor.orgId}`)
      .catch(logSideEffectFailure("analytics cache eviction", { orgId: actor.orgId, projectId }));
    return result;
  }

  async authorizeMutation(tx: Db, actor: CurrentUserContext, projectId: number, ticketIds: number[]) {
    const policy = await authorizeTicketMutation(tx, this.access, actor, projectId);
    await lockProjectTicketMutation(tx, actor.orgId, projectId);
    return readMutationTickets(tx, actor, projectId, ticketIds, policy);
  }

  async rankTicket(actor: CurrentUserContext, projectId: number, ticketId: number, body: RankTicketInput) {
    return rankTicket(this.db, this.cache, this.access, actor, projectId, ticketId, body, {
      webhooksDispatch: this.webhooksDispatch,
      automationRunner: this.automationRunner,
      activity: this.activity,
      dispatch: this.dispatch,
      transfer: this.transfer,
    });
  }
}
