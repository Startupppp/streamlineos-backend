import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { webLeadForms } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import type { WebFormCreateInput, WebFormUpdateInput } from "./dto/web-forms.schemas";

@Injectable()
export class CrmWebFormsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  list(orgId: string) {
    return this.db
      .select()
      .from(webLeadForms)
      .where(eq(webLeadForms.orgId, orgId))
      .orderBy(webLeadForms.createdAt);
  }

  async create(orgId: string, userId: string, input: WebFormCreateInput) {
    const publicToken = randomUUID().replace(/-/g, "").slice(0, 16);

    const [created] = await this.db
      .insert(webLeadForms)
      .values({
        orgId,
        name: input.name,
        description: input.description ?? null,
        fields: input.fields,
        publicToken,
        isActive: input.isActive,
        submitMessage: input.submitMessage ?? "Thank you! We'll be in touch soon.",
        redirectUrl: input.redirectUrl || null,
        createdBy: userId,
      })
      .returning();

    return created;
  }

  getOne(orgId: string, id: number) {
    return this.db
      .select()
      .from(webLeadForms)
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)))
      .then((rows) => rows[0] ?? null);
  }

  async exists(orgId: string, id: number): Promise<boolean> {
    const [row] = await this.db
      .select({ id: webLeadForms.id })
      .from(webLeadForms)
      .where(and(eq(webLeadForms.id, id), eq(webLeadForms.orgId, orgId)));
    return Boolean(row);
  }

  update(id: number, input: WebFormUpdateInput) {
    return this.db
      .update(webLeadForms)
      .set({ ...input, updatedAt: new Date() })
      .where(eq(webLeadForms.id, id))
      .returning()
      .then((rows) => rows[0]);
  }

  async remove(id: number) {
    await this.db.delete(webLeadForms).where(eq(webLeadForms.id, id));
    return { success: true };
  }
}
