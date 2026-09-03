import { NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { actingMembershipId } from "../../common/auth/principal";
import { signEnvelopes } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";

/**
 * Neither `sign:certificate:download` nor `sign:audit:view` is scopable, so their
 * own grants can only ever resolve "all". Envelope visibility is decided by
 * `sign:envelope:view`, which is — and a per-person `user_permission_grants` row
 * may hand someone a download or audit key while their view key stays `own`.
 * Binding those routes to the scope resolved here is what stops that grant from
 * reading every executed contract, and every signing trail, in the org.
 */
export const SIGN_ENVELOPE_VIEW_PERMISSION = "sign:envelope:view";

export interface EnvelopeViewScope {
  membershipId: number | null;
  viewAll: boolean;
}

/** For reads the finalization pipeline makes on its own behalf, never for a request. */
export const SYSTEM_ENVELOPE_SCOPE: EnvelopeViewScope = Object.freeze({
  membershipId: null,
  viewAll: true,
});

export function envelopeIsVisible(
  senderMembershipId: number | null,
  scope: EnvelopeViewScope,
): boolean {
  if (scope.viewAll) return true;
  return scope.membershipId != null && senderMembershipId === scope.membershipId;
}

export async function resolveEnvelopeViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<EnvelopeViewScope> {
  const scope = await access.scopeFor(u, SIGN_ENVELOPE_VIEW_PERMISSION);
  return { membershipId: actingMembershipId(u.principal), viewAll: scope === "all" };
}

/**
 * Out of scope and out of tenant answer the same 404 a missing envelope answers:
 * a 403 here would confirm that the envelope exists.
 */
export async function mustGetVisibleEnvelope(
  db: Db,
  orgId: string,
  envelopeId: number,
  scope: EnvelopeViewScope,
  notFoundMessage: string,
) {
  const envelope = await db.query.signEnvelopes.findFirst({
    where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
  });
  if (!envelope || !envelopeIsVisible(envelope.senderMembershipId, scope))
    throw new NotFoundException(notFoundMessage);
  return envelope;
}
