import { Body, Controller, ForbiddenException, Inject, NotFoundException, Post, UseGuards } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { JwtAuthGuard } from "../../common/auth/jwt-auth.guard";
import { PermissionGuard } from "../access/permission.guard";
import { RequirePermission } from "../access/require-permission.decorator";
import { CurrentUser } from "../../common/auth/current-user.decorator";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { projectMembers, tickets } from "../../db/schema";
import { RequireModule } from "../../common/rbac/require-module.decorator";
import { ticketStatusActionSchema, type TicketStatusActionInput } from "./dto/chat.schemas";

@RequireModule("chat")
@Controller("chat/actions")
@UseGuards(JwtAuthGuard, PermissionGuard)
export class ChatActionsController {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  @Post("ticket-status")
  @RequirePermission("projects:tickets:update")
  async changeTicketStatus(
    @Body(new ZodValidationPipe(ticketStatusActionSchema)) body: TicketStatusActionInput,
    @CurrentUser() u: CurrentUserContext,
  ) {
    if (!u.isOrgOwner && !u.isPlatformAdmin) {
      const membership = await this.db.query.projectMembers.findFirst({
        where: and(eq(projectMembers.projectId, body.projectId), eq(projectMembers.userId, u.userId)),
        columns: { projectId: true },
      });
      if (!membership) throw new ForbiddenException("Not a project member");
    }

    const ticket = await this.db.query.tickets.findFirst({
      where: and(eq(tickets.id, body.ticketId), eq(tickets.projectId, body.projectId), eq(tickets.orgId, u.orgId)),
      columns: { id: true, status: true },
    });

    if (!ticket) throw new NotFoundException("Ticket not found");

    await this.db
      .update(tickets)
      .set({ status: body.nextStatus, updatedAt: new Date() })
      .where(and(eq(tickets.id, body.ticketId), eq(tickets.orgId, u.orgId)));

    return { success: true, prevStatus: ticket.status, nextStatus: body.nextStatus };
  }
}
