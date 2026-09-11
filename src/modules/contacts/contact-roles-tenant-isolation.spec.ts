import { NotFoundException } from "@nestjs/common";
import { crmContactRoles } from "../../db/schema";
import { businessParties, contactPartyMap } from "../../db/schema/party";
import { tenantDb } from "../../test/tenant-recorder";
import { ContactRolesService } from "./contact-roles.service";

/**
 * Cross-tenant isolation for contact roles (who is the champion, the economic
 * buyer, … on a deal).
 *
 * Every method first proves the contact is in the caller's org through the
 * Party map, then reads or writes `crm_contact_roles` under the same org. The
 * fixtures hold the OWNER's contact and role; the double answers by the
 * equalities each statement bound, so a missing org predicate hands the
 * owner's contact or role to the attacker.
 */

const OWNER_ORG = "org-owner";
const ATTACKER_ORG = "org-attacker";

const OWNER_ROLE = {
  orgId: OWNER_ORG,
  id: "role-owner",
  contactId: 7,
  entityType: "deal",
  entityId: 5,
  roleKey: "champion",
  isPrimary: false,
};

function build() {
  const t = tenantDb({
    fixtures: [
      {
        table: contactPartyMap,
        org: contactPartyMap.organizationId,
        rows: [
          { organizationId: OWNER_ORG, contactId: 7, id: 7 },
          { organizationId: ATTACKER_ORG, contactId: 8, id: 8 },
        ],
      },
      { table: crmContactRoles, org: crmContactRoles.orgId, rows: [OWNER_ROLE] },
    ],
  });
  const audit = { log: jest.fn() };
  return { t, audit, service: new ContactRolesService(t.db, audit as never) };
}

describe("ContactRolesService — cross-tenant isolation", () => {
  it("deny: another org's contact is a 404 and none of its roles are read", async () => {
    const { t, service } = build();

    await expect(service.listRoles(ATTACKER_ORG, 7, {})).rejects.toBeInstanceOf(NotFoundException);
    const [contactCheck] = t.on(contactPartyMap, "select");
    expect(t.orgBound(contactCheck, contactPartyMap.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.orgBound(contactCheck, businessParties.organizationId)).toEqual([ATTACKER_ORG]);
    expect(t.on(crmContactRoles)).toHaveLength(0);
  });

  it("deny: a role cannot be added to another org's contact", async () => {
    const { t, audit, service } = build();

    await expect(
      service.addRole(ATTACKER_ORG, 7, { entityType: "deal", entityId: 5, roleKey: "champion", isPrimary: false } as never, "usr-attacker"),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(t.on(crmContactRoles, "insert")).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("deny: removing another org's role id from the caller's own contact deletes nothing", async () => {
    const { t, audit, service } = build();

    await expect(service.removeRole(ATTACKER_ORG, 8, "role-owner", "usr-attacker")).rejects.toBeInstanceOf(NotFoundException);
    expect(t.orgBound(t.on(crmContactRoles, "delete")[0], crmContactRoles.orgId)).toEqual([ATTACKER_ORG]);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("control: the owning org lists and removes its own contact's role", async () => {
    const { t, service } = build();

    expect((await service.listRoles(OWNER_ORG, 7, {})).map((role) => role.id)).toEqual(["role-owner"]);
    expect(await service.removeRole(OWNER_ORG, 7, "role-owner", "usr-owner")).toEqual({ success: true });
    expect(t.orgBound(t.on(crmContactRoles, "delete")[0], crmContactRoles.orgId)).toEqual([OWNER_ORG]);
  });
});
