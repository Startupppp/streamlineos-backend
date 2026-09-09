import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";
import { chatHuddleParticipants, chatHuddles, organizationMembers } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";

@Injectable()
export class ChatHuddleSignalsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async heartbeat(huddleId: number, userId: string, orgId: string): Promise<{ ok: boolean }> {
    const huddle = await this.db.query.chatHuddles.findFirst({
      where: and(eq(chatHuddles.id, huddleId), eq(chatHuddles.orgId, orgId)),
      columns: { id: true },
    });
    if (!huddle) throw new NotFoundException("Huddle not found");
    const callerMembership = await this.db.query.organizationMembers.findFirst({
      where: and(eq(organizationMembers.orgId, orgId), eq(organizationMembers.userId, userId)),
      columns: { id: true },
    });
    if (!callerMembership) throw new ForbiddenException("Your membership is no longer active");
    await this.db
      .update(chatHuddleParticipants)
      .set({ lastSeenAt: sql`now()` })
      .where(
        and(
          eq(chatHuddleParticipants.orgId, orgId),
          eq(chatHuddleParticipants.huddleId, huddleId),
          eq(chatHuddleParticipants.membershipId, callerMembership.id),
          isNull(chatHuddleParticipants.leftAt),
        ),
      );
    return { ok: true };
  }
}
