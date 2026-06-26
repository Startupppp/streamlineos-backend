import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { emailTemplates } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { CreateEmailTemplateInput, UpdateEmailTemplateInput } from "./dto/email-templates.schemas";

@Injectable()
export class HrEmailTemplatesService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(emailTemplates)
      .where(eq(emailTemplates.orgId, orgId))
      .orderBy(desc(emailTemplates.createdAt));
  }

  async create(orgId: string, userId: string, input: CreateEmailTemplateInput) {
    const existing = await this.db.query.emailTemplates.findFirst({
      where: and(
        eq(emailTemplates.orgId, orgId),
        sql`lower(trim(${emailTemplates.name})) = ${input.name.toLowerCase()}`,
      ),
      columns: { id: true },
    });
    if (existing) throw new ConflictException("A template with this name already exists.");

    const [record] = await this.db
      .insert(emailTemplates)
      .values({
        orgId,
        name: input.name,
        subject: input.subject,
        body: input.body,
        category: input.category ?? "GENERAL",
        variables: input.variables ?? null,
        createdBy: userId,
      })
      .returning();

    return record;
  }

  async update(orgId: string, id: number, input: UpdateEmailTemplateInput) {
    const [updated] = await this.db
      .update(emailTemplates)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(emailTemplates.id, id), eq(emailTemplates.orgId, orgId)))
      .returning();

    if (!updated) throw new NotFoundException("Template not found.");
    return updated;
  }

  async remove(orgId: string, id: number) {
    const [deleted] = await this.db
      .delete(emailTemplates)
      .where(and(eq(emailTemplates.id, id), eq(emailTemplates.orgId, orgId)))
      .returning();

    if (!deleted) throw new NotFoundException("Template not found.");
    return { success: true };
  }
}
