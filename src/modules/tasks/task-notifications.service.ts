import { Inject, Injectable } from "@nestjs/common";
import { inArray } from "drizzle-orm";
import { users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { EmailService } from "../email/email.service";

@Injectable()
export class TaskNotificationsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly email: EmailService,
  ) {}

  async notifyAssignee(params: {
    assigneeId: string;
    actorId: string;
    title: string;
    type: string;
    dueDate: Date | null;
    entityLabel?: string;
  }): Promise<void> {
    const ids = Array.from(new Set([params.assigneeId, params.actorId]));
    const people = await this.db
      .select({ id: users.id, email: users.email, name: users.name })
      .from(users)
      .where(inArray(users.id, ids));

    const assignee = people.find((p) => p.id === params.assigneeId);
    if (!assignee?.email) return;

    const actor = people.find((p) => p.id === params.actorId);
    const dueStr = params.dueDate
      ? params.dueDate.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

    await this.email.sendTaskAssignedEmail(
      assignee.email,
      assignee.name ?? "Team Member",
      params.title,
      params.type,
      dueStr,
      actor?.name ?? "Team Member",
      params.entityLabel,
    );
  }
}
