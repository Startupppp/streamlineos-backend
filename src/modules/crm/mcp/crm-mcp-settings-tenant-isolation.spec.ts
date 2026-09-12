import { crmMcpSettings } from "../../../db/schema";
import { tenantDb } from "../../../test/tenant-recorder";
import { CrmMcpSettingsService } from "./crm-mcp-settings.service";

/**
 * Cross-tenant isolation for the switch that lets agents drive an org's CRM.
 *
 * The one thing this must never do is answer "on" for an org because a
 * different org switched it on. The fixture holds the OWNER's row, enabled; the
 * double answers by the equalities each statement bound, so without the org
 * predicate the owner's `enabled: true` reaches the attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

function build() {
  const t = tenantDb({
    fixtures: [
      {
        table: crmMcpSettings,
        org: crmMcpSettings.organizationId,
        rows: [{ organizationId: OWNER_ORG, enabled: true, updatedByUserId: "usr-owner", updatedAt: new Date("2026-09-01") }],
      },
    ],
  });
  return { t, service: new CrmMcpSettingsService(t.db) };
}

describe("CrmMcpSettingsService — cross-tenant isolation", () => {
  it("deny: another org having agent access on does not turn it on for the caller", async () => {
    const { t, service } = build();

    expect(await service.isEnabled(ATTACKER_ORG)).toBe(false);
    expect(t.orgBound(t.on(crmMcpSettings, "select")[0], crmMcpSettings.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: reading settings for an org with no row synthesises that org's own default, not another org's row", async () => {
    const { t, service } = build();

    expect(await service.read(ATTACKER_ORG)).toMatchObject({ organizationId: ATTACKER_ORG, enabled: false, updatedByUserId: null });
    expect(t.orgBound(t.on(crmMcpSettings, "select")[0], crmMcpSettings.organizationId)).toEqual([ATTACKER_ORG]);
  });

  it("deny: switching it on writes only the caller's org row", async () => {
    const { t, service } = build();

    await service.setEnabled(ATTACKER_ORG, "usr-attacker", true);

    expect(t.inserted(crmMcpSettings)).toEqual([
      expect.objectContaining({ organizationId: ATTACKER_ORG, enabled: true, updatedByUserId: "usr-attacker" }),
    ]);
  });

  it("control: the owning org's own switch reads as on", async () => {
    const { service } = build();

    expect(await service.isEnabled(OWNER_ORG)).toBe(true);
    expect(await service.read(OWNER_ORG)).toMatchObject({ organizationId: OWNER_ORG, enabled: true });
  });
});
