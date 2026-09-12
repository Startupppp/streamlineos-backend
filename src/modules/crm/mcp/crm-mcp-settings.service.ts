import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.types";
import { crmMcpSettings } from "../../../db/schema";

/**
 * Whether an organisation lets agents drive its CRM.
 *
 * A separate service from `CrmMcpService` on purpose: the tool surface should
 * not be able to answer this question about itself, and keeping the switch
 * behind its own reader is what makes "is agent access on" a single expression
 * rather than a condition each caller assembles.
 */
@Injectable()
export class CrmMcpSettingsService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  /**
   * A missing row means off.
   *
   * The absence of a decision is not consent. Reading it as `true` would make
   * the default depend on whether anybody had ever opened the settings screen,
   * which is the opposite of a default.
   */
  async isEnabled(orgId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ enabled: crmMcpSettings.enabled })
      .from(crmMcpSettings)
      .where(eq(crmMcpSettings.organizationId, orgId))
      .limit(1);

    return row?.enabled === true;
  }

  async read(orgId: string) {
    const [row] = await this.db
      .select()
      .from(crmMcpSettings)
      .where(eq(crmMcpSettings.organizationId, orgId))
      .limit(1);

    /**
     * Synthesised rather than created. Reading a setting must not write one —
     * a `GET` that inserts turns every settings screen into a mutation and makes
     * "nobody has decided yet" indistinguishable from "somebody chose off".
     */
    return (
      row ?? {
        organizationId: orgId,
        enabled: false,
        updatedByUserId: null,
        updatedAt: null,
      }
    );
  }

  async setEnabled(orgId: string, userId: string, enabled: boolean) {
    const [row] = await this.db
      .insert(crmMcpSettings)
      .values({ organizationId: orgId, enabled, updatedByUserId: userId })
      .onConflictDoUpdate({
        target: crmMcpSettings.organizationId,
        set: { enabled, updatedByUserId: userId, updatedAt: new Date() },
      })
      .returning();

    if (!row) throw new Error("crm mcp settings upsert returned nothing");
    return row;
  }
}
