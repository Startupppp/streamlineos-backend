import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import { crmMcpServerEnablement } from "../../db/schema/crm/crm-mcp";
import { AuditService } from "../../common/audit/audit.service";

/**
 * Whether a tenant has turned the protocol surface on.
 *
 * Ticket 19's last criterion. Off is the answer when there is no row, which
 * makes "off by default" a property of the storage rather than of a default
 * somebody has to remember to write — a new organisation, a restored backup and
 * a tenant created by a migration all agree without anyone deciding.
 *
 * Turning it on is audited through `logCritical` rather than `log`. Best-effort
 * telemetry is the right default for most things and the wrong one here: this
 * write is the record that a human opened a machine doorway onto a customer's
 * CRM, and losing it because a log insert failed leaves a surface that is on
 * with nobody's name against it — which is precisely the state the CHECK
 * constraint on the table refuses to store.
 */

export interface McpEnablementState {
  readonly enabled: boolean;
  readonly enabledAt: Date | null;
  readonly enabledBy: string | null;
  readonly disabledAt: Date | null;
  readonly disabledBy: string | null;
}

const OFF: McpEnablementState = {
  enabled: false,
  enabledAt: null,
  enabledBy: null,
  disabledAt: null,
  disabledBy: null,
};

@Injectable()
export class CrmMcpEnablementService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  async state(orgId: string): Promise<McpEnablementState> {
    const rows = await this.db
      .select({
        enabled: crmMcpServerEnablement.enabled,
        enabledAt: crmMcpServerEnablement.enabledAt,
        enabledBy: crmMcpServerEnablement.enabledBy,
        disabledAt: crmMcpServerEnablement.disabledAt,
        disabledBy: crmMcpServerEnablement.disabledBy,
      })
      .from(crmMcpServerEnablement)
      .where(eq(crmMcpServerEnablement.organizationId, orgId))
      .limit(1);

    return rows[0] ?? OFF;
  }

  async isEnabled(orgId: string): Promise<boolean> {
    return (await this.state(orgId)).enabled;
  }

  async set(orgId: string, actorUserId: string, enabled: boolean): Promise<McpEnablementState> {
    const now = new Date();

    /*
      The disabling half keeps `enabled_at` and `enabled_by` rather than nulling
      them. Who first opened the surface stays answerable after somebody else
      closes it; clearing the columns would make the row read as though it had
      never been on.
    */
    const values = enabled
      ? { organizationId: orgId, enabled: true, enabledAt: now, enabledBy: actorUserId }
      : { organizationId: orgId, enabled: false, disabledAt: now, disabledBy: actorUserId };

    await this.db
      .insert(crmMcpServerEnablement)
      .values(values)
      .onConflictDoUpdate({
        target: crmMcpServerEnablement.organizationId,
        set: { ...values, updatedAt: now },
      });

    await this.audit.logCritical({
      action: enabled ? "crm.mcp.server.enabled" : "crm.mcp.server.disabled",
      userId: actorUserId,
      orgId,
      actorUserId,
      targetType: "crm_mcp_server",
      targetId: orgId,
      resourceType: "crm_mcp_server",
      resourceId: orgId,
      result: "SUCCESS",
      metadata: { moduleKey: "crm", protocol: "mcp" },
    });

    return this.state(orgId);
  }
}
