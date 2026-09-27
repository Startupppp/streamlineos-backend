import { Inject, Injectable } from "@nestjs/common";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsTicketsUpdateService } from "./projects-tickets-update.service";
import { readTicketVersionForSystemWrite } from "./tickets-helpers";
import type { UpdateTicketInput } from "../dto/projects.schemas";

@Injectable()
export class ProjectsTicketsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly update: ProjectsTicketsUpdateService,
  ) {}

  async updateTicketFromSystem(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    input: Omit<UpdateTicketInput, "version">,
  ) {
    const version = await readTicketVersionForSystemWrite(
      this.db,
      u.orgId,
      ticketId,
    );
    return this.update.updateTicket(u, projectId, ticketId, {
      ...input,
      version,
    });
  }
}
