import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { TicketVersionConflictException } from "../tickets/ticket-version-conflict.exception";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { projects, roadmapItems } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import type {
  CreateRoadmapInput,
  RoadmapListQuery,
  UpdateRoadmapInput,
} from "../dto/projects.schemas";
import {
  buildTupleCursorPage,
  decodeTupleCursor,
} from "../../../../common/pagination/cursor";
import { PAGE_SIZE_CAP } from "../../../../common/pagination/list-query.schema";
import { assertRoadmapTargetsInOrg } from "./roadmap-references";
import {
  computeRoadmapPrioritization,
  type RiceInputs,
  type RoadmapPrioritization,
} from "./roadmap-prioritization";
import {
  loadRoadmapDeliveryProgress,
  loadRoadmapDemandSignals,
} from "./roadmap-delivery";
import {
  publishRoadmap,
  readRoadmapPublication,
  rotateRoadmapPublicationToken,
  unpublishRoadmap,
} from "./roadmap-publication";
import {
  applyRoadmapTierWeighting,
  loadRoadmapAccountTiers,
  type RoadmapAccountTierSummary,
  type RoadmapTierWeighting,
} from "./roadmap-accounts";

const ROADMAP_SEARCH_MIN_TERM_LENGTH = 3;
export const ROADMAP_SEARCH_ID_CAP = 500;

type RoadmapSortMode = "sort_order" | "updated_at" | "created_at" | "title";

interface RoadmapPageKey {
  readonly sortValue: string;
  readonly id: number;
}

interface RoadmapOrdering {
  readonly orderBy: SQL[];
  readonly toPositionParts: (row: {
    id: number;
    sortOrder: number;
    updatedAt: Date;
    createdAt: Date;
    title: string;
  }) => readonly [string, string, string];
  readonly buildBoundary: (key: RoadmapPageKey) => SQL | undefined;
}

function sortModeFromQuery(sort: RoadmapListQuery["sort"]): RoadmapSortMode {
  return sort ?? "sort_order";
}

type RoadmapCursorDecoded =
  | { match: "valid"; key: RoadmapPageKey }
  | { match: "absent" }
  | { match: "cross_sort" };

function decodeRoadmapCursor(
  cursor: string | undefined | null,
  mode: RoadmapSortMode,
): RoadmapCursorDecoded {
  if (typeof cursor !== "string" || cursor.length === 0) return { match: "absent" };
  const parts = decodeTupleCursor(cursor, 3);
  if (!parts) return { match: "absent" };
  const [cursorMode, sortValue, rawId] = parts;
  if (cursorMode !== mode) return { match: "cross_sort" };
  if (!/^[1-9][0-9]{0,9}$/.test(rawId)) return { match: "absent" };
  const id = Number(rawId);
  if (!Number.isSafeInteger(id) || id > 2_147_483_647) return { match: "absent" };
  return { match: "valid", key: { sortValue, id } };
}

function buildRoadmapOrdering(mode: RoadmapSortMode): RoadmapOrdering {
  switch (mode) {
    case "sort_order":
      return {
        orderBy: [asc(roadmapItems.sortOrder), asc(roadmapItems.id)],
        toPositionParts: (row) =>
          [mode, String(row.sortOrder), String(row.id)] as const,
        buildBoundary: (key) => {
          const val = Number(key.sortValue);
          if (!Number.isInteger(val)) return undefined;
          return or(
            gt(roadmapItems.sortOrder, val),
            and(eq(roadmapItems.sortOrder, val), gt(roadmapItems.id, key.id)),
          );
        },
      };
    case "updated_at":
      return {
        orderBy: [desc(roadmapItems.updatedAt), asc(roadmapItems.id)],
        toPositionParts: (row) =>
          [mode, row.updatedAt.toISOString(), String(row.id)] as const,
        buildBoundary: (key) => {
          const ts = new Date(key.sortValue);
          if (Number.isNaN(ts.getTime())) return undefined;
          return or(
            lt(roadmapItems.updatedAt, ts),
            and(eq(roadmapItems.updatedAt, ts), gt(roadmapItems.id, key.id)),
          );
        },
      };
    case "created_at":
      return {
        orderBy: [desc(roadmapItems.createdAt), asc(roadmapItems.id)],
        toPositionParts: (row) =>
          [mode, row.createdAt.toISOString(), String(row.id)] as const,
        buildBoundary: (key) => {
          const ts = new Date(key.sortValue);
          if (Number.isNaN(ts.getTime())) return undefined;
          return or(
            lt(roadmapItems.createdAt, ts),
            and(eq(roadmapItems.createdAt, ts), gt(roadmapItems.id, key.id)),
          );
        },
      };
    case "title":
      return {
        orderBy: [asc(roadmapItems.title), asc(roadmapItems.id)],
        toPositionParts: (row) => [mode, row.title, String(row.id)] as const,
        buildBoundary: (key) =>
          or(
            gt(roadmapItems.title, key.sortValue),
            and(
              eq(roadmapItems.title, key.sortValue),
              gt(roadmapItems.id, key.id),
            ),
          ),
      };
  }
}

type Scored<T> = T & {
  prioritization: RoadmapPrioritization;
  tierWeighting: RoadmapTierWeighting;
};

function withPrioritization<T extends RiceInputs>(
  row: T,
  accounts?: RoadmapAccountTierSummary,
): Scored<T> {
  const prioritization = computeRoadmapPrioritization(row);
  return {
    ...row,
    prioritization,
    tierWeighting: applyRoadmapTierWeighting(prioritization, accounts),
  };
}

@Injectable()
export class ProjectsRoadmapService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
  ) {}

  searchFallbackCondition(term: string): SQL {
    const like = `%${term}%`;
    const condition = or(
      ilike(roadmapItems.title, like),
      ilike(roadmapItems.description, like),
    );
    if (!condition) return sql`false`;
    return condition;
  }

  async searchCondition(term: string): Promise<SQL> {
    if (term.length < ROADMAP_SEARCH_MIN_TERM_LENGTH)
      return this.searchFallbackCondition(term);
    const idRows = await this.db.execute(
      sql`SELECT app.search_roadmap_item_ids(${term}, ${ROADMAP_SEARCH_ID_CAP + 1}) AS id`,
    );
    if (idRows.length > ROADMAP_SEARCH_ID_CAP)
      return this.searchFallbackCondition(term);
    const ids = idRows.map((row) => Number(row["id"]));
    if (ids.length === 0) return sql`false`;
    return inArray(roadmapItems.id, ids);
  }

  async listRoadmap(orgId: string, query: RoadmapListQuery) {
    const { cursor, limit: rawLimit } = query;
    const limit = Math.min(rawLimit, PAGE_SIZE_CAP);
    const mode = sortModeFromQuery(query.sort);
    const ordering = buildRoadmapOrdering(mode);
    const cursorDecoded = decodeRoadmapCursor(cursor, mode);
    if (cursorDecoded.match === "cross_sort")
      throw new BadRequestException(
        "Cursor was issued under a different sort order — resubmit without a cursor",
      );
    const position = cursorDecoded.match === "valid" ? cursorDecoded.key : null;
    const conditions = [
      eq(roadmapItems.orgId, orgId),
      isNull(roadmapItems.deletedAt),
    ];
    if (query.status) conditions.push(eq(roadmapItems.status, query.status));
    if (query.search) conditions.push(await this.searchCondition(query.search));
    if (query.managedProductId !== undefined) {
      const sub = this.db
        .select({ id: projects.id })
        .from(projects)
        .where(
          and(
            eq(projects.orgId, orgId),
            eq(projects.managedProductId, query.managedProductId),
          ),
        );
      conditions.push(inArray(roadmapItems.projectId, sub));
    }
    if (position) {
      const boundary = ordering.buildBoundary(position);
      if (boundary) conditions.push(boundary);
    }
    const where = and(...conditions);
    const rows = await this.db.query.roadmapItems.findMany({
      where,
      orderBy: ordering.orderBy,
      limit: limit + 1,
    });
    return buildTupleCursorPage(rows, limit, (row) =>
      ordering.toPositionParts(row),
    );
  }

  async listRoadmapWithPrioritization(orgId: string, query: RoadmapListQuery) {
    const page = await this.listRoadmap(orgId, query);
    const accounts = await loadRoadmapAccountTiers(
      this.db,
      orgId,
      page.data.map((row) => row.id),
    );
    return {
      ...page,
      data: page.data.map((row) =>
        withPrioritization(row, accounts.get(row.id)),
      ),
    };
  }

  private async accountTiersOf(orgId: string, itemId: number) {
    const accounts = await loadRoadmapAccountTiers(this.db, orgId, [itemId]);
    return accounts.get(itemId);
  }

  async createRoadmap(
    orgId: string,
    userId: string,
    input: CreateRoadmapInput,
  ) {
    await assertRoadmapTargetsInOrg(this.db, orgId, input);
    const [item] = await this.db
      .insert(roadmapItems)
      .values({
        orgId,
        title: input.title,
        description: input.description ?? null,
        status: input.status,
        category: input.category ?? null,
        isPublic: input.isPublic,
        projectId: input.projectId ?? null,
        epicTicketId: input.epicTicketId ?? null,
        targetQuarter: input.targetQuarter ?? null,
        sortOrder: input.sortOrder,
        reach: input.reach ?? null,
        impact: input.impact ?? null,
        confidence: input.confidence ?? null,
        effort: input.effort ?? null,
        createdBy: userId,
      })
      .returning();
    return withPrioritization(item, await this.accountTiersOf(orgId, item.id));
  }

  async getRoadmap(orgId: string, itemId: number) {
    const item = await this.db.query.roadmapItems.findFirst({
      where: and(
        eq(roadmapItems.id, itemId),
        eq(roadmapItems.orgId, orgId),
        isNull(roadmapItems.deletedAt),
      ),
    });
    if (!item) throw new NotFoundException("Roadmap item not found");
    return withPrioritization(item, await this.accountTiersOf(orgId, item.id));
  }

  async updateRoadmap(
    orgId: string,
    itemId: number,
    input: UpdateRoadmapInput,
  ) {
    await assertRoadmapTargetsInOrg(this.db, orgId, input);
    const before = await this.db.query.roadmapItems.findFirst({
      where: and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId), isNull(roadmapItems.deletedAt)),
      columns: { version: true },
    });
    if (!before) throw new NotFoundException("Roadmap item not found");
    if (input.version !== before.version) throw new TicketVersionConflictException(before.version);

    const { version: _v, ...rest } = input;
    const [updated] = await this.db
      .update(roadmapItems)
      .set({ ...rest, updatedAt: new Date() })
      .where(
        and(
          eq(roadmapItems.id, itemId),
          eq(roadmapItems.orgId, orgId),
          isNull(roadmapItems.deletedAt),
          eq(roadmapItems.version, before.version),
        ),
      )
      .returning();
    if (!updated) {
      const [current] = await this.db.select({ version: roadmapItems.version }).from(roadmapItems).where(and(eq(roadmapItems.id, itemId), eq(roadmapItems.orgId, orgId))).limit(1);
      throw new TicketVersionConflictException(current?.version ?? before.version);
    }
    return withPrioritization(
      updated,
      await this.accountTiersOf(orgId, updated.id),
    );
  }

  async getRoadmapSignals(orgId: string, itemId: number) {
    const item = await this.getRoadmap(orgId, itemId);
    const [demand, delivery] = await Promise.all([
      loadRoadmapDemandSignals(this.db, orgId, item.id, item.votes),
      loadRoadmapDeliveryProgress(this.db, orgId, {
        projectId: item.projectId,
        epicTicketId: item.epicTicketId,
      }),
    ]);
    return {
      itemId: item.id,
      prioritization: item.prioritization,
      tierWeighting: item.tierWeighting,
      demand,
      delivery,
    };
  }

  async deleteRoadmap(orgId: string, itemId: number) {
    const [deleted] = await this.db
      .update(roadmapItems)
      .set({ deletedAt: new Date() })
      .where(
        and(
          eq(roadmapItems.id, itemId),
          eq(roadmapItems.orgId, orgId),
          isNull(roadmapItems.deletedAt),
        ),
      )
      .returning({ id: roadmapItems.id });
    if (!deleted) throw new NotFoundException("Roadmap item not found");
    return { success: true };
  }

  readPublication(orgId: string) {
    return readRoadmapPublication(this.db, orgId);
  }

  publish(orgId: string) {
    return publishRoadmap(this.db, orgId);
  }

  rotatePublicationToken(orgId: string) {
    return rotateRoadmapPublicationToken(this.db, orgId);
  }

  unpublish(orgId: string) {
    return unpublishRoadmap(this.db, orgId);
  }
}
