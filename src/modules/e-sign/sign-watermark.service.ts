import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signWatermarkPolicies } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignAuditService } from "./sign-audit.service";
import type { WatermarkPolicyInput } from "./dto/e-sign.schemas";

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

  async create(orgId: string, userId: string, input: WatermarkPolicyInput) {
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
    await this.get(orgId, id);
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
