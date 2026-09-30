import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { ticketLabelMappings } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { logger } from "../../../../common/logger/logger.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { withSavepoint } from "../../../data-quality/savepoint";
import { ProjectsActivityService } from "../activity/projects-activity.service";
import { AccessService } from "../../../access/access.service";
import {
  assertTicketReadAccess,
  type TicketReadAccess,
} from "./build-ticket-read-access";
import type { AddLabelInput } from "../dto/projects.schemas";

@Injectable()
export class ProjectsTicketLabelsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    @Inject(AccessService) private readonly access: TicketReadAccess,
    private readonly activity: ProjectsActivityService,
  ) {}

  async addTicketLabel(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    body: AddLabelInput,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const [mapping] = await this.db
      .insert(ticketLabelMappings)
      .values({ orgId: u.orgId, ticketId, labelId: body.labelId })
      .onConflictDoNothing()
      .returning({ id: ticketLabelMappings.id });
    if (mapping)
      await this.logLabelChange(u.orgId, ticketId, u.userId);
    return { success: true };
  }

  async removeTicketLabel(
    u: CurrentUserContext,
    projectId: number,
    ticketId: number,
    labelId: number,
  ) {
    await assertTicketReadAccess(this.db, this.access, u, projectId, ticketId);
    const deleted = await this.db
      .delete(ticketLabelMappings)
      .where(
        and(
          eq(ticketLabelMappings.ticketId, ticketId),
          eq(ticketLabelMappings.labelId, labelId),
          eq(ticketLabelMappings.orgId, u.orgId),
        ),
      )
      .returning({ id: ticketLabelMappings.id });
    if (deleted.length > 0)
      await this.logLabelChange(u.orgId, ticketId, u.userId);
    return { success: true };
  }

  private async logLabelChange(
    orgId: string,
    ticketId: number,
    userId: string,
  ): Promise<void> {
    try {
      await withSavepoint(() => this.activity.logTicketActivity(
        orgId,
        ticketId,
        userId,
        "label_changed",
      ));
    } catch (error) {
      logger.error("Failed to log label activity", { error });
    }
  }
}
