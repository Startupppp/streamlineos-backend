import { Injectable } from "@nestjs/common";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import type { CommentInput } from "../dto/projects.schemas";
import { ProjectsTicketCommentsService } from "./projects-ticket-comments.service";

@Injectable()
export class ProjectsTicketSubresourcesService {
  constructor(private readonly comments: ProjectsTicketCommentsService) {}

  addComment(
    u: CurrentUserContext,
    projectId: number | null,
    ticketId: number,
    body: CommentInput,
  ) {
    return this.comments.addComment(u, projectId, ticketId, body);
  }
}
