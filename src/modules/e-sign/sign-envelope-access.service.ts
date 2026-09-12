import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { actingMembershipId } from "../../common/auth/principal";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { signDocuments, signFields, signRecipients } from "../../db/schema";
import { AccessService } from "../access/access.service";
import { mustGetVisibleEnvelope, resolveEnvelopeViewScope } from "./sign-envelope-scope";

/**
 * What an actor may change is bounded by what they may see.
 *
 * `sign:envelope:view` is the only scopable SignOS key, so a module member
 * resolves it at `own` and reads only the envelopes they sent. The mutation
 * keys — `create`, `send`, `void`, `correct`, `documents:upload` — are not
 * scopable, and every mutating service method is bound to the organisation
 * alone. A per-person grant of one of those keys therefore let its holder act
 * on any envelope in the organisation by id, including envelopes the same
 * request would refuse to show them. Each mutating handler asks here first;
 * an envelope the actor cannot see answers the 404 a read of it would.
 */
@Injectable()
export class SignEnvelopeAccessService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly access: AccessService,
  ) {}

  async mustGetActionable(u: CurrentUserContext, envelopeId: number) {
    const read = await resolveEnvelopeViewScope(this.access, u);
    return mustGetVisibleEnvelope(this.db, read, actingMembershipId(u.principal), envelopeId, "Envelope not found");
  }

  async mustGetActionableByRecipient(u: CurrentUserContext, recipientId: number) {
    const [row] = await this.db
      .select({ envelopeId: signRecipients.envelopeId })
      .from(signRecipients)
      .where(and(eq(signRecipients.orgId, u.orgId), eq(signRecipients.id, recipientId)))
      .limit(1);
    if (!row) throw new NotFoundException("Recipient not found");
    return this.mustGetActionable(u, row.envelopeId);
  }

  async mustGetActionableByField(u: CurrentUserContext, fieldId: number) {
    const [row] = await this.db
      .select({ envelopeId: signFields.envelopeId })
      .from(signFields)
      .where(and(eq(signFields.orgId, u.orgId), eq(signFields.id, fieldId)))
      .limit(1);
    if (!row) throw new NotFoundException("Field not found");
    return this.mustGetActionable(u, row.envelopeId);
  }

  async mustGetActionableByDocument(u: CurrentUserContext, documentId: number) {
    const [row] = await this.db
      .select({ envelopeId: signDocuments.envelopeId })
      .from(signDocuments)
      .where(and(eq(signDocuments.orgId, u.orgId), eq(signDocuments.id, documentId)))
      .limit(1);
    if (!row) throw new NotFoundException("Document not found");
    return this.mustGetActionable(u, row.envelopeId);
  }
}
