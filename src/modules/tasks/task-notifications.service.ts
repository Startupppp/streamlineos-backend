import { Inject, Injectable } from "@nestjs/common";
import { NotificationDispatchService } from "../notifications/notification-dispatch.service";

@Injectable()
export class TaskNotificationsService {
  constructor(
    private readonly dispatch: NotificationDispatchService,
  ) {}

  async notifyAssignee(params: {
    orgId: string;
    assigneeId: string;
    actorId: string;
    title: string;
    type: string;
    dueDate: Date | null;
    entityLabel?: string;
  }): Promise<void> {
    const dueStr = params.dueDate
      ? params.dueDate.toLocaleDateString("en-IN", {
          day: "numeric",
          month: "short",
          year: "numeric",
        })
      : null;

    await this.dispatch.emit({
      eventKey: "tasks.task.assigned",
      orgId: params.orgId,
      actorUserId: params.actorId,
      targetUserIds: [params.assigneeId],
      entityType: params.entityLabel ?? "task",
      title: "Task assigned to you",
      message: `${params.title}${dueStr ? ` (due ${dueStr})` : ""}`,
      link: "/tasks",
      variables: { title: params.title, type: params.type, dueDate: dueStr, entityLabel: params.entityLabel ?? null },
    });
  }
}
