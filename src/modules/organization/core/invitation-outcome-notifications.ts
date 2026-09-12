import { and, eq } from "drizzle-orm";
import { runInNewTenantTransaction } from "../../../common/tenant/run-in-tenant-transaction";
import { getOrgAdminRecipients } from "../../../common/tenant/org-admin-recipients";
import { type Db } from "../../../db/drizzle.module";
import { organizationMembers } from "../../../db/schema";
import { NotificationDispatchService } from "../../notifications/notification-dispatch.service";

const INVITATION_MANAGEMENT_LINK = "/settings/users?view=invitations";

async function resolveInviterUserId(
  db: Db,
  orgId: string,
  inviterMembershipId: number | null,
): Promise<string | null> {
  if (inviterMembershipId === null) return null;
  const row = await runInNewTenantTransaction(db, orgId, (tx) =>
    tx.query.organizationMembers.findFirst({
      where: and(
        eq(organizationMembers.id, inviterMembershipId),
        eq(organizationMembers.orgId, orgId),
      ),
      columns: { userId: true },
    }),
  );
  return row?.userId ?? null;
}

async function resolveRecipients(
  db: Db,
  orgId: string,
  inviterMembershipId: number | null,
): Promise<string[]> {
  const inviterUserId = await resolveInviterUserId(db, orgId, inviterMembershipId);
  // Public route, so no ambient GUC; inside the callback the DRIZZLE proxy routes `db` to `tx`.
  return runInNewTenantTransaction(db, orgId, () =>
    getOrgAdminRecipients(db, orgId, [inviterUserId]),
  );
}

export async function notifyInvitationAccepted(
  db: Db,
  dispatch: NotificationDispatchService,
  orgId: string,
  invitationId: string,
  email: string,
  inviterMembershipId: number | null,
  joinedUserId: string,
): Promise<void> {
  const targetUserIds = (
    await resolveRecipients(db, orgId, inviterMembershipId)
  ).filter((id) => id !== joinedUserId);
  if (targetUserIds.length === 0) return;

  await dispatch.emit({
    eventKey: "organization.invitation.accepted",
    orgId,
    actorUserId: joinedUserId,
    targetUserIds,
    entityType: "invitation",
    entityId: invitationId,
    title: "Invitation accepted",
    message: `${email} accepted their invitation and joined the organization.`,
    link: INVITATION_MANAGEMENT_LINK,
  });
}

export async function notifyInvitationDeclined(
  db: Db,
  dispatch: NotificationDispatchService,
  orgId: string,
  invitationId: string,
  email: string,
  inviterMembershipId: number | null,
): Promise<void> {
  const targetUserIds = await resolveRecipients(db, orgId, inviterMembershipId);
  if (targetUserIds.length === 0) return;

  await dispatch.emit({
    eventKey: "organization.invitation.declined",
    orgId,
    targetUserIds,
    entityType: "invitation",
    entityId: invitationId,
    title: "Invitation declined",
    message: `${email} declined the invitation to join the organization.`,
    link: INVITATION_MANAGEMENT_LINK,
  });
}
