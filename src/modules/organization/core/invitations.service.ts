import { Injectable } from "@nestjs/common";
import { InvitationCreateService } from "./invitation-create.service";
import { InvitationLifecycleService } from "./invitation-lifecycle.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";
import type { InviteActor } from "./invitations.helpers";

export type { InviteActor } from "./invitations.helpers";

@Injectable()
export class InvitationsService {
  constructor(
    private readonly create: InvitationCreateService,
    private readonly lifecycle: InvitationLifecycleService,
  ) {}

  invite(orgId: string, actor: InviteActor, email: string, role: string) {
    return this.create.invite(orgId, actor, email, role);
  }

  bulkInvite(orgId: string, actor: InviteActor, emails: string[], role: string) {
    return this.create.bulkInvite(orgId, actor, emails, role);
  }

  resend(orgId: string, invitationId: string, actor: InviteActor) {
    return this.lifecycle.resend(orgId, invitationId, actor);
  }

  changeRole(orgId: string, invitationId: string, actor: InviteActor, role: string) {
    return this.lifecycle.changeRole(orgId, invitationId, actor, role);
  }

  cancel(orgId: string, invitationId: string, actor: InviteActor) {
    return this.lifecycle.cancel(orgId, invitationId, actor);
  }

  revokeAllPending(orgId: string, existingTx?: DbOrTx) {
    return this.lifecycle.revokeAllPending(orgId, existingTx);
  }
}
