import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signEnvelopes, signTemplates, signWatermarkPolicies } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import type { WatermarkPolicyInput } from "./dto/e-sign-settings.schemas";

@Injectable()
export class SignWatermarkService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: SignAuditService,
  ) {}

  async list(orgId: string) {
    return this.db.query.signWatermarkPolicies.findMany({ where: eq(signWatermarkPolicies.orgId, orgId), limit: 100 });
  }

  async get(orgId: string, id: number) {
    const policy = await this.db.query.signWatermarkPolicies.findFirst({ where: and(eq(signWatermarkPolicies.id, id), eq(signWatermarkPolicies.orgId, orgId)) });
    if (!policy) throw new NotFoundException("Watermark policy not found");
    return policy;
  }

  /**
   * `scopeId` arrives in the REQUEST BODY and names a template or an envelope.
   * `sign_watermark_policies.scope_id` carries no foreign key at all — it is a
   * polymorphic pointer discriminated by `scope_type` — so nothing in the
   * database refuses another organisation's id, and until this ran the value was
   * written straight into the row without being read back under the caller's
   * org. Out of tenant answers the same 404 an absent target answers.
   */
  private async assertScopeTarget(orgId: string, scopeType: string, scopeId: number | undefined): Promise<void> {
    if (scopeType === "tenant") {
      if (scopeId !== undefined) throw new BadRequestException("A tenant-wide policy does not take a scope id");
      return;
    }
    if (scopeId === undefined) throw new BadRequestException(`A ${scopeType}-scoped policy requires a scope id`);
    const found =
      scopeType === "template"
        ? await this.db.query.signTemplates.findFirst({
            columns: { id: true },
            where: and(eq(signTemplates.id, scopeId), eq(signTemplates.orgId, orgId)),
          })
        : await this.db.query.signEnvelopes.findFirst({
            columns: { id: true },
            where: and(eq(signEnvelopes.id, scopeId), eq(signEnvelopes.orgId, orgId)),
          });
    if (!found) throw new NotFoundException("Watermark scope target not found");
  }

  async create(orgId: string, userId: string, input: WatermarkPolicyInput) {
    await this.assertScopeTarget(orgId, input.scopeType, input.scopeId);
    const [policy] = await this.db
      .insert(signWatermarkPolicies)
      .values({
        orgId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        appliesStates: input.appliesStates,
        text: input.text,
        opacity: input.opacity,
        angle: input.angle,
        color: input.color,
        fontSize: input.fontSize,
        placement: input.placement,
        pages: input.pages,
        showOnFinalPdf: input.showOnFinalPdf,
        previewOnly: input.previewOnly,
        enabled: input.enabled,
      })
      .returning();

    await this.audit.record({
      orgId,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "admin_setting_changed",
      eventMessage: `Created watermark policy #${policy.id}`,
    });
    return policy;
  }

  async update(orgId: string, id: number, userId: string, input: Partial<WatermarkPolicyInput>) {
    const existing = await this.get(orgId, id);
    if (input.scopeType !== undefined || input.scopeId !== undefined)
      await this.assertScopeTarget(
        orgId,
        input.scopeType ?? existing.scopeType,
        input.scopeId ?? (input.scopeType === undefined ? (existing.scopeId ?? undefined) : undefined),
      );
    const [updated] = await this.db
      .update(signWatermarkPolicies)
      .set({ ...input, updatedAt: new Date() })
      .where(and(eq(signWatermarkPolicies.id, id), eq(signWatermarkPolicies.orgId, orgId)))
      .returning();

    await this.audit.record({
      orgId,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "admin_setting_changed",
      eventMessage: `Updated watermark policy #${id}`,
    });
    return updated;
  }

  async remove(orgId: string, id: number, userId: string) {
    await this.get(orgId, id);
    await this.db.delete(signWatermarkPolicies).where(and(eq(signWatermarkPolicies.id, id), eq(signWatermarkPolicies.orgId, orgId)));
    await this.audit.record({
      orgId,
      actorType: "internal_user",
      actorUserId: userId,
      eventType: "admin_setting_changed",
      eventMessage: `Deleted watermark policy #${id}`,
    });
  }
}
