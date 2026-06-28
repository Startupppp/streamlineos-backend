import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { kbSpaces, kbSpaceMembers, kbArticles } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { KbAccessService } from "./kb-access.service";
import { applyScope } from "../access/apply-scope";
import type { DataScope } from "../access/access.types";
import { kbSlugify } from "./kb.util";
import type { CreateSpaceInput, UpdateSpaceInput } from "./dto/kb.schemas";

type SpaceRow = typeof kbSpaces.$inferSelect;

type SpaceListItem = Pick<
  SpaceRow,
  "id" | "name" | "slug" | "description" | "audience" | "icon" | "isPublicHelpCenter" | "createdAt" | "updatedAt"
> & { articleCount: number };

@Injectable()
export class KbSpacesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: KbAccessService,
  ) {}

  async list(user: CurrentUserContext, scope?: DataScope): Promise<SpaceListItem[]> {
    if (scope === "none") return [];

    const ids = await this.access.getAccessibleSpaceIds(user);
    if (ids.length === 0) return [];

    const baseConditions = [eq(kbSpaces.orgId, user.orgId), inArray(kbSpaces.id, ids), isNull(kbSpaces.deletedAt)];
    if (scope && scope !== "all") {
      baseConditions.push(applyScope(scope, user.userId, { ownerColumn: kbSpaces.createdById }));
    }

    const spaces = await this.db
      .select({
        id: kbSpaces.id,
        name: kbSpaces.name,
        slug: kbSpaces.slug,
        description: kbSpaces.description,
        audience: kbSpaces.audience,
        icon: kbSpaces.icon,
        isPublicHelpCenter: kbSpaces.isPublicHelpCenter,
        createdAt: kbSpaces.createdAt,
        updatedAt: kbSpaces.updatedAt,
      })
      .from(kbSpaces)
      .where(and(...baseConditions))
      .orderBy(desc(kbSpaces.updatedAt));
    const counts = await this.db
      .select({ spaceId: kbArticles.spaceId, count: sql<number>`count(*)::int` })
      .from(kbArticles)
      .where(and(eq(kbArticles.orgId, user.orgId), inArray(kbArticles.spaceId, ids)))
      .groupBy(kbArticles.spaceId);
    const countMap = new Map(counts.map((c) => [c.spaceId, c.count]));
    return spaces.map((s) => ({ ...s, articleCount: countMap.get(s.id) ?? 0 }));
  }

  async create(orgId: string, userId: string, input: CreateSpaceInput): Promise<SpaceRow> {
    const slug = kbSlugify(input.name);
    if (!slug) throw new ConflictException("Invalid space name");
    const existing = await this.db.query.kbSpaces.findFirst({
      where: and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.slug, slug)),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A space with this name already exists");
    return this.db.transaction(async (tx) => {
      const [space] = await tx
        .insert(kbSpaces)
        .values({
          orgId,
          name: input.name,
          slug,
          description: input.description ?? null,
          audience: input.audience,
          icon: input.icon ?? null,
          isPublicHelpCenter: input.isPublicHelpCenter ?? false,
          createdById: userId,
        })
        .returning();
      await tx.insert(kbSpaceMembers).values({
        orgId,
        spaceId: space.id,
        userId,
        spaceRole: "admin",
      });
      return space;
    });
  }

  async get(user: CurrentUserContext, spaceId: number): Promise<SpaceRow> {
    const space = await this.db.query.kbSpaces.findFirst({
      where: and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, user.orgId), isNull(kbSpaces.deletedAt)),
    });
    if (!space) throw new NotFoundException("Space not found");
    await this.access.assertSpaceAccessible(user, spaceId);
    return space;
  }

  async update(orgId: string, spaceId: number, input: UpdateSpaceInput): Promise<SpaceRow> {
    const values: Partial<typeof kbSpaces.$inferInsert> = { updatedAt: new Date() };
    if (input.description !== undefined) values.description = input.description ?? null;
    if (input.audience !== undefined) values.audience = input.audience;
    if (input.icon !== undefined) values.icon = input.icon ?? null;
    if (input.isPublicHelpCenter !== undefined) values.isPublicHelpCenter = input.isPublicHelpCenter;
    if (input.name !== undefined) {
      const slug = kbSlugify(input.name);
      if (!slug) throw new ConflictException("Invalid space name");
      const clash = await this.db.query.kbSpaces.findFirst({
        where: and(eq(kbSpaces.orgId, orgId), eq(kbSpaces.slug, slug), ne(kbSpaces.id, spaceId)),
        columns: { id: true },
      });
      if (clash) throw new ConflictException("A space with this name already exists");
      values.name = input.name;
      values.slug = slug;
    }
    const [updated] = await this.db
      .update(kbSpaces)
      .set(values)
      .where(and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId)))
      .returning();
    if (!updated) throw new NotFoundException("Space not found");
    return updated;
  }

  async remove(orgId: string, spaceId: number): Promise<{ success: boolean }> {
    const [deleted] = await this.db
      .update(kbSpaces)
      .set({ deletedAt: new Date() })
      .where(and(eq(kbSpaces.id, spaceId), eq(kbSpaces.orgId, orgId), isNull(kbSpaces.deletedAt)))
      .returning({ id: kbSpaces.id });
    if (!deleted) throw new NotFoundException("Space not found");
    return { success: true };
  }
}
