import { ConflictException, Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import { handbookVersions } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { type Db } from "../../../db/drizzle.module";
import type { CreateHandbookInput, UpdateHandbookInput } from "./dto/handbook.schemas";

type HandbookExisting = { id: number; publishedAt: Date | null };

interface HandbookUpdateData {
  publishedAt?: Date | null;
  publishedBy?: string | null;
  changelog?: string;
  title?: string;
  version?: string;
  documentUrl?: string | null;
}

@Injectable()
export class HrHandbookService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select({
        id: handbookVersions.id,
        version: handbookVersions.version,
        title: handbookVersions.title,
        documentId: handbookVersions.documentId,
        documentUrl: handbookVersions.documentUrl,
        changelog: handbookVersions.changelog,
        publishedAt: handbookVersions.publishedAt,
        publishedBy: handbookVersions.publishedBy,
        createdAt: handbookVersions.createdAt,
      })
      .from(handbookVersions)
      .where(eq(handbookVersions.orgId, orgId))
      .orderBy(desc(handbookVersions.createdAt))
      .limit(100);
  }

  getById(orgId: string, id: number): Promise<HandbookExisting | null> {
    return this.db.query.handbookVersions
      .findFirst({
        where: and(eq(handbookVersions.id, id), eq(handbookVersions.orgId, orgId)),
        columns: { id: true, publishedAt: true },
      })
      .then((row) => row ?? null);
  }

  async create(orgId: string, input: CreateHandbookInput) {
    const existing = await this.db.query.handbookVersions.findFirst({
      where: and(
        eq(handbookVersions.orgId, orgId),
        eq(handbookVersions.title, input.title),
        eq(handbookVersions.version, input.version),
      ),
      columns: { id: true },
    });
    if (existing) {
      throw new ConflictException(
        `A handbook version "${input.version}" with title "${input.title}" already exists.`,
      );
    }

    const [record] = await this.db
      .insert(handbookVersions)
      .values({
        orgId,
        version: input.version,
        title: input.title,
        documentId: input.documentId ?? null,
        documentUrl: input.documentUrl ?? null,
        changelog: input.changelog ?? null,
        publishedAt: null,
        publishedBy: null,
      })
      .returning();

    return record;
  }

  async update(orgId: string, userId: string, existing: HandbookExisting, input: UpdateHandbookInput) {
    const updateData: HandbookUpdateData = {};

    if (input.status === "PUBLISHED") {
      updateData.publishedAt = new Date();
      updateData.publishedBy = userId;
    } else if (input.status === "DRAFT") {
      updateData.publishedAt = null;
      updateData.publishedBy = null;
    }

    if (!existing.publishedAt) {
      if (input.title !== undefined) updateData.title = input.title;
      if (input.version !== undefined) updateData.version = input.version;
      if (input.documentUrl !== undefined) updateData.documentUrl = input.documentUrl || null;
    }

    if (input.changelog !== undefined) {
      updateData.changelog = input.changelog;
    }

    await this.db
      .update(handbookVersions)
      .set(updateData)
      .where(and(eq(handbookVersions.id, existing.id), eq(handbookVersions.orgId, orgId)));

    return { success: true };
  }

  async remove(orgId: string, existing: HandbookExisting) {
    if (existing.publishedAt) {
      throw new ConflictException("Cannot delete a published handbook version. Unpublish it first.");
    }

    await this.db
      .delete(handbookVersions)
      .where(and(eq(handbookVersions.id, existing.id), eq(handbookVersions.orgId, orgId)));

    return { success: true };
  }
}
