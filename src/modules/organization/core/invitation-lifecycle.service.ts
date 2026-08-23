import { Injectable } from "@nestjs/common";
import { InvitationsService } from "./invitations.service";
import type { InviteActor } from "./invitations.service";
import type { DbOrTx } from "../../../common/rbac/access-invalidate";

@Injectable()
export class InvitationLifecycleService {
  constructor(private readonly invitations: InvitationsService) {}

  cancel(orgId: string, invitationId: string, actor: InviteActor) {
    return this.invitations.cancel(orgId, invitationId, actor);
  }

  changeRole(orgId: string, invitationId: string, actor: InviteActor, role: string) {
    return this.invitations.changeRole(orgId, invitationId, actor, role);
  }

  revokeAllPending(orgId: string, existingTx?: DbOrTx) {
    return this.invitations.revokeAllPending(orgId, existingTx);
  }
}
