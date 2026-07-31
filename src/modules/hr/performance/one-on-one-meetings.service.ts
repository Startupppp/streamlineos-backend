import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, desc, eq, gte, or } from "drizzle-orm";
import {
  oneOnOneMeetings,
  organizationMembers,
} from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type {
  CreateOneOnOneInput,
  UpdateOneOnOneInput,
} from "./dto/performance.schemas";

@Injectable()
export class OneOnOneMeetingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async listOneOnOnes(orgId: string, userId: string, upcoming: boolean) {
    const conditions = [
      eq(oneOnOneMeetings.orgId, orgId),
      or(
        eq(oneOnOneMeetings.managerId, userId),
        eq(oneOnOneMeetings.employeeId, userId),
      ),
    ];
    if (upcoming) {
      conditions.push(gte(oneOnOneMeetings.scheduledAt, new Date()));
    }

    const data = await this.db.query.oneOnOneMeetings.findMany({
      where: and(...conditions),
      with: {
        manager: { columns: { id: true, name: true, image: true } },
        employee: { columns: { id: true, name: true, image: true } },
      },
      orderBy: [desc(oneOnOneMeetings.scheduledAt)],
      limit: 100,
    });

    return data.map((m) => ({
      ...m,
      scheduledAt:
        m.scheduledAt instanceof Date
          ? m.scheduledAt.toISOString()
          : m.scheduledAt,
    }));
  }

  async createOneOnOne(
    orgId: string,
    managerId: string,
    input: CreateOneOnOneInput,
  ) {
    await this.assertOrgMember(orgId, input.employeeId);

    const scheduledTime = new Date(input.scheduledAt);
    const duplicate = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(
        eq(oneOnOneMeetings.orgId, orgId),
        eq(oneOnOneMeetings.employeeId, input.employeeId),
        eq(oneOnOneMeetings.scheduledAt, scheduledTime),
      ),
      columns: { id: true },
    });
    if (duplicate) {
      throw new ConflictException(
        "A 1-on-1 is already scheduled with this employee at this time.",
      );
    }

    const [meeting] = await this.db
      .insert(oneOnOneMeetings)
      .values({
        orgId,
        managerId,
        employeeId: input.employeeId,
        scheduledAt: scheduledTime,
        duration: input.duration ?? 30,
        agenda: input.agenda,
        meetingLink: input.meetingLink || undefined,
        status: "SCHEDULED",
      })
      .returning();

    return meeting;
  }

  async updateOneOnOne(
    orgId: string,
    actorId: string,
    canManage: boolean,
    meetingId: number,
    input: UpdateOneOnOneInput,
  ) {
    const existing = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(
        eq(oneOnOneMeetings.id, meetingId),
        eq(oneOnOneMeetings.orgId, orgId),
      ),
      columns: { id: true, managerId: true, employeeId: true },
    });
    if (!existing) throw new NotFoundException("Meeting not found.");
    if (
      !canManage &&
      existing.managerId !== actorId &&
      existing.employeeId !== actorId
    ) {
      throw new ForbiddenException(
        "You can only modify your own 1-on-1 meetings.",
      );
    }

    await this.db
      .update(oneOnOneMeetings)
      .set({
        ...(input.scheduledAt !== undefined && {
          scheduledAt: new Date(input.scheduledAt),
        }),
        ...(input.duration !== undefined && { duration: input.duration }),
        ...(input.status !== undefined && { status: input.status }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.actionItems !== undefined && {
          actionItems: input.actionItems,
        }),
        ...(input.agenda !== undefined && { agenda: input.agenda }),
        ...(input.meetingLink !== undefined && {
          meetingLink: input.meetingLink,
        }),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(oneOnOneMeetings.id, meetingId),
          eq(oneOnOneMeetings.orgId, orgId),
        ),
      );

    return { success: true };
  }

  async deleteOneOnOne(
    orgId: string,
    actorId: string,
    canManage: boolean,
    meetingId: number,
  ) {
    const existing = await this.db.query.oneOnOneMeetings.findFirst({
      where: and(
        eq(oneOnOneMeetings.id, meetingId),
        eq(oneOnOneMeetings.orgId, orgId),
      ),
      columns: { id: true, managerId: true, employeeId: true },
    });
    if (!existing) throw new NotFoundException("Meeting not found.");
    if (
      !canManage &&
      existing.managerId !== actorId &&
      existing.employeeId !== actorId
    ) {
      throw new ForbiddenException(
        "You can only delete your own 1-on-1 meetings.",
      );
    }

    await this.db
      .delete(oneOnOneMeetings)
      .where(
        and(
          eq(oneOnOneMeetings.id, meetingId),
          eq(oneOnOneMeetings.orgId, orgId),
        ),
      );
    return { success: true };
  }

  private async assertOrgMember(orgId: string, userId: string): Promise<void> {
    const member = await this.db.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.orgId, orgId),
        eq(organizationMembers.userId, userId),
      ),
      columns: { id: true },
    });
    if (!member)
      throw new NotFoundException("Employee not found in your organization.");
  }
}
