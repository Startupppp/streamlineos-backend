import type { DispatchResult } from "./notification-dispatch.service";
import type { DispatchEventInput } from "./notification.types";

export interface OrgMemberFixture {
  readonly userId: string;
  readonly membershipId: number;
}

export interface PersistedRecipientRow {
  readonly orgId: string;
  readonly eventKey: string;
  readonly userId: string;
  readonly membershipId: number;
}

/**
 * Stands in for `NotificationDispatchService` at a call site under test and
 * reproduces the one dimension these specs are about: which membership row the
 * dispatcher would stamp on each recipient's `notifications` row.
 *
 * It mirrors three rules of `NotificationDispatchService.dispatch`, and only
 * those three — the actor is dropped unless `notifySelf`, a target who is not an
 * active org member is dropped by `filterOrgMemberIds`, and every surviving
 * recipient is stamped with `organizationMembers.id`.
 * `notification-recipient-membership.spec.ts` pins that mirror against the real
 * services, so a call-site spec asserting on `rows` is asserting about the row
 * production really writes.
 */
export class MembershipResolvingDispatchDouble {
  readonly inputs: DispatchEventInput[] = [];
  readonly rows: PersistedRecipientRow[] = [];

  constructor(private readonly members: readonly OrgMemberFixture[]) {}

  emit = async (input: DispatchEventInput): Promise<DispatchResult> => {
    this.inputs.push(input);
    const requested =
      input.actorUserId && input.notifySelf !== true
        ? input.targetUserIds.filter((id) => id !== input.actorUserId)
        : input.targetUserIds;

    let notified = 0;
    for (const userId of requested) {
      const member = this.members.find((candidate) => candidate.userId === userId);
      if (!member) continue;
      this.rows.push({
        orgId: input.orgId,
        eventKey: input.eventKey,
        userId,
        membershipId: member.membershipId,
      });
      notified += 1;
    }

    return {
      eventKey: input.eventKey,
      notified,
      deliveriesQueued: 0,
      suppressed: 0,
      deduped: 0,
      deferred: false,
      failedRecipients: 0,
    };
  };

  rowsFor(userId: string): PersistedRecipientRow[] {
    return this.rows.filter((row) => row.userId === userId);
  }

  eventKeys(): string[] {
    return this.inputs.map((input) => input.eventKey);
  }
}
