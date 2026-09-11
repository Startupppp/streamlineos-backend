import { CRM_PERMISSIONS } from "../rbac/permissions/crm";
import { PARTY_FIELD_MIRROR } from "../party/party-mirror-fields";

/**
 * `crm:contacts:view` is not scopable, and the reason is that a contact has no
 * owner. Both halves are pinned here, because the first without the second is
 * just a preference somebody will reverse.
 *
 * The key WAS declared `scopable: true`, from the day it was born until 0670.
 * No route ever applied it: `modules/contacts/` has no `applyScope`, no
 * `DataScope` and no `readRequestScope`, so an administrator could grant a rep
 * `own` and every contact in the organisation stayed visible. It was withdrawn
 * rather than implemented because there is nothing to scope BY — see the
 * catalogue entry in `permissions/crm.ts` for the full reasoning.
 *
 * Found by `src/scripts/census-scopable-keys-unenforced.mjs`.
 */
describe("crm:contacts:view is not scopable", () => {
  const entry = CRM_PERMISSIONS.find((p) => p.name === "crm:contacts:view");

  it("declares no scope, because no contact read could apply one", () => {
    expect(entry).toBeDefined();
    expect(entry?.scopable).toBeUndefined();
  });

  /**
   * The fact the decision rests on, asserted where it lives.
   *
   * `business_parties.owner_user_id` is the column a contact WOULD be scoped by
   * — contacts resolve through Party, and `contact-party-reader.ts` already
   * joins the table that holds it. It stays null for a contact because the
   * mirror maps it for LEAD (`assigned_to_id`) and CLIENT
   * (`account_manager_id`) and for nothing else.
   *
   * So if someone gives CONTACT an owner mapping, this fails — and that is the
   * point. It is the moment the decision above stops being right, and the
   * failure should land on the person creating the owner rather than on a rep
   * who quietly sees everything a year later.
   */
  it("has no owner on the party behind it, which is why", () => {
    const owner = PARTY_FIELD_MIRROR.ownerUserId;

    expect(Object.keys(owner).sort()).toEqual(["CLIENT", "LEAD"]);
    expect(owner).not.toHaveProperty("CONTACT");
  });

  /** Unchanged: the write key was never scopable, so nothing moved on that side. */
  it("leaves the manage key alone", () => {
    const manage = CRM_PERMISSIONS.find((p) => p.name === "crm:contacts:manage");

    expect(manage).toBeDefined();
    expect(manage?.scopable).toBeUndefined();
  });
});
