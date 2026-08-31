import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, asc, eq, sql, isNull } from "drizzle-orm";
import { kbSpaces, kbSpaceMembers, kbPages, kbArticles, users } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import { KbAccessService } from "../core/kb-access.service";
import { KbIndexingService } from "../retrieval/kb-indexing.service";
import { registerAfterCommit } from "../../../common/tenant/tenant-context";
import type { AddMemberInput } from "./dto/kb-members.schemas";

type MemberRow = typeof kbSpaceMembers.$inferSelect;

type MemberListItem = MemberRow & {
  userName: string | null;
  userEmail: string | null;
  userImage: string | null;
};

@Injectable()
export class KbMembersService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
    private readonly indexing: KbIndexingService,
  ) {}

  private async assertSpaceExists(orgId: string, spaceId: number): Promise<void> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(
        eq(kbSpaces.id, spaceId),
        eq(kbSpaces.orgId, orgId),
        isNull(kbSpaces.deletedAt),
      ),
      columns: { id: true },
    });
    if (!space) throw new NotFoundException("Space not found");
  }

  async list(orgId: string, spaceId: number): Promise<MemberListItem[]> {
    await this.assertSpaceExists(orgId, spaceId);
    return this.db
      .select({
        id: kbSpaceMembers.id,
        orgId: kbSpaceMembers.orgId,
        spaceId: kbSpaceMembers.spaceId,
        userId: kbSpaceMembers.userId,
        role: kbSpaceMembers.role,
        team: kbSpaceMembers.team,
        spaceRole: kbSpaceMembers.spaceRole,
        createdAt: kbSpaceMembers.createdAt,
        userName: users.name,
        userEmail: users.email,
        userImage: users.image,
      })
      .from(kbSpaceMembers)
      .leftJoin(users, eq(kbSpaceMembers.userId, users.id))
      .where(and(eq(kbSpaceMembers.orgId, orgId), eq(kbSpaceMembers.spaceId, spaceId)))
      .orderBy(asc(kbSpaceMembers.spaceRole), asc(kbSpaceMembers.createdAt));
  }

  async add(orgId: string, spaceId: number, input: AddMemberInput): Promise<MemberRow> {
    await this.assertSpaceExists(orgId, spaceId);
    if (input.userId) {
      const existing = await this.db.query.kbSpaceMembers.findFirst({
        where: and(eq(kbSpaceMembers.spaceId, spaceId), eq(kbSpaceMembers.userId, input.userId)),
        columns: { id: true },
      });
      if (existing) throw new ConflictException("User already has access");
    }
    if (input.role) {
      const existing = await this.db.query.kbSpaceMembers.findFirst({
        where: and(eq(kbSpaceMembers.spaceId, spaceId), eq(kbSpaceMembers.role, input.role)),
        columns: { id: true },
      });
      if (existing) throw new ConflictException("Role already granted");
    }
    const [member] = await this.db
      .insert(kbSpaceMembers)
      .values({
        orgId,
        spaceId,
        userId: input.userId ?? null,
        role: input.role ?? null,
        spaceRole: input.spaceRole,
      })
      .returning();
    await this.bumpSpaceAclRevision(orgId, spaceId);
    await this.access.invalidateAccessibleSpaceIds(orgId);
    await this.scheduleAclReindex(orgId, spaceId);
    return member;
  }

  private async scheduleAclReindex(orgId: string, spaceId: number): Promise<void> {
    const registered = registerAfterCommit(async () => {
      await this.indexing.syncAclRevisionForSpace(orgId, spaceId);
    });
    if (!registered) {
      await this.indexing.syncAclRevisionForSpace(orgId, spaceId);
    }
  }

  private async bumpSpaceAclRevision(orgId: string, spaceId: number): Promise<void> {
    await Promise.all([
      this.db
        .update(kbPages)
        .set({ aclRevision: sql`acl_revision + 1` })
        .where(and(eq(kbPages.orgId, orgId), eq(kbPages.spaceId, spaceId))),
      this.db
        .update(kbArticles)
        .set({ aclRevision: sql`acl_revision + 1` })
        .where(and(eq(kbArticles.orgId, orgId), eq(kbArticles.spaceId, spaceId))),
    ]);
  }

  async remove(orgId: string, spaceId: number, memberId: number): Promise<{ success: boolean }> {
    const member = await this.db.query.kbSpaceMembers.findFirst({
      where: and(
        eq(kbSpaceMembers.id, memberId),
        eq(kbSpaceMembers.spaceId, spaceId),
        eq(kbSpaceMembers.orgId, orgId),
      ),
    });
    if (!member) throw new NotFoundException("Member not found");
    if (member.spaceRole === "admin") {
      const [{ count }] = await this.db
        .select({ count: sql<number>`count(*)::int` })
        .from(kbSpaceMembers)
        .where(
          and(
            eq(kbSpaceMembers.orgId, orgId),
            eq(kbSpaceMembers.spaceId, spaceId),
            eq(kbSpaceMembers.spaceRole, "admin"),
          ),
        );
      if (count <= 1) throw new BadRequestException("Cannot remove the last space admin");
    }
    await this.db
      .delete(kbSpaceMembers)
      .where(
        and(
          eq(kbSpaceMembers.id, memberId),
          eq(kbSpaceMembers.spaceId, spaceId),
          eq(kbSpaceMembers.orgId, orgId),
        ),
      );
    await this.bumpSpaceAclRevision(orgId, spaceId);
    await this.access.invalidateAccessibleSpaceIds(orgId);
    await this.scheduleAclReindex(orgId, spaceId);
    return { success: true };
  }
}
