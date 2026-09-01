import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { auditLogs, hrDataRequests, organizationMembers, users } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import type { GdprRectificationBody } from "./dto/gdpr-rectification.schemas";

@Injectable()
export class GdprRectificationService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async rectifyOwnProfile(
    orgId: string,
    subjectUserId: string,
    input: GdprRectificationBody,
    ipAddress?: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [membership] = await tx
        .select({ id: organizationMembers.id, status: organizationMembers.status })
        .from(organizationMembers)
        .where(
          and(
            eq(organizationMembers.orgId, orgId),
            eq(organizationMembers.userId, subjectUserId),
            eq(organizationMembers.status, "ACTIVE"),
          ),
        )
        .limit(1);
      if (!membership || membership.status !== "ACTIVE")
        throw new NotFoundException("Subject not found in active organization");

      const [current] = await tx
        .select({ id: users.id, name: users.name })
        .from(users)
        .where(eq(users.id, subjectUserId))
        .limit(1);
      if (!current) throw new NotFoundException("Subject not found");

      const changed = current.name !== input.value;
      let correctedName = current.name;
      if (changed) {
        const currentNameCondition = current.name === null
          ? isNull(users.name)
          : eq(users.name, current.name);
        const [updated] = await tx
          .update(users)
          .set({ name: input.value })
          .where(and(eq(users.id, subjectUserId), currentNameCondition))
          .returning({ name: users.name });
        if (!updated || updated.name !== input.value)
          throw new ConflictException("Rectification could not be verified");
        correctedName = updated.name;
      }

      const [request] = await tx
        .insert(hrDataRequests)
        .values({
          orgId,
          subjectUserId,
          type: "correction",
          status: "completed",
          requestedBy: subjectUserId,
          reason: input.field,
          completedAt: new Date(),
        })
        .returning({ id: hrDataRequests.id });
      if (!request) throw new ConflictException("Rectification request could not be recorded");

      await tx.insert(auditLogs).values({
        action: changed ? "gdpr.rectification.completed" : "gdpr.rectification.no_change",
        userId: subjectUserId,
        orgId,
        targetId: subjectUserId,
        targetType: "user",
        actorUserId: subjectUserId,
        resourceType: "gdpr_rectification",
        resourceId: String(request.id),
        metadata: {
          field: input.field,
          beforeHash: this.valueHash(current.name),
          afterHash: this.valueHash(correctedName),
          changed,
        },
        ipAddress,
      });

      return { requestId: request.id, field: input.field, changed, status: "completed" as const };
    });
  }

  private valueHash(value: string | null): string {
    return createHash("sha256").update(value ?? "").digest("hex");
  }
}
