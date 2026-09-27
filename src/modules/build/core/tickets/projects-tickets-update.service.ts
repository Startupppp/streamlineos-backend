import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { CacheService } from "../../../../common/cache/cache.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { ProjectsActivityService } from "../projects-activity.service";
import { ProjectsTicketsQueryService } from "./projects-tickets-query.service";
import { ProjectsTicketsTransferService } from "./projects-tickets-transfer.service";
import { ProjectsWebhooksDispatchService } from "../projects-webhooks-dispatch.service";
import { BuildAutomationRunnerService } from "../automation/build-automation-runner.service";
import { AccessService } from "../../../access/access.service";
import type { UpdateTicketInput } from "../dto/projects.schemas";
import { applyTicketChange } from "./apply-ticket-change";

@Injectable()
export class ProjectsTicketsUpdateService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly dispatch: NotificationDispatchService,
    private readonly activity: ProjectsActivityService,
    private readonly query: ProjectsTicketsQueryService,
    private readonly transfer: ProjectsTicketsTransferService,
    private readonly webhooksDispatch: ProjectsWebhooksDispatchService,
    private readonly automationRunner: BuildAutomationRunnerService,
    private readonly cache: CacheService,
    private readonly access: AccessService,
  ) {}

  async updateTicket(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    input: UpdateTicketInput,
  ) {
    return applyTicketChange(
      {
        db: this.db,
        dispatch: this.dispatch,
        activity: this.activity,
        query: this.query,
        transfer: this.transfer,
        webhooksDispatch: this.webhooksDispatch,
        automationRunner: this.automationRunner,
        cache: this.cache,
        access: this.access,
      },
      u,
      projectId,
      ticketId,
      input,
    );
  }
}
