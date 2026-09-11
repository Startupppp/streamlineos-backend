import { NotFoundException } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import type { CurrentUserContext } from "../../common/auth/backend-claims";
import { signEnvelopes } from "../../db/schema";
import { type Db } from "../../db/drizzle.module";
import { AccessService } from "../access/access.service";
import { ScopedRead, type OwnershipScope } from "../access/scoped-read";

/**
 * Neither `sign:certificate:download` nor `sign:audit:view` is scopable, so their
 * own grants can only ever resolve "all". Envelope visibility is decided by
 * `sign:envelope:view`, which is — and a per-person `user_permission_grants` row
 * may hand someone a download or audit key while their view key stays `own`.
 * Binding those routes to the scope resolved here is what stops that grant from
 * reading every executed contract, and every signing trail, in the org.
 */
export const SIGN_ENVELOPE_VIEW_PERMISSION = "sign:envelope:view";

export function envelopeSenderScope(membershipId: number | null): OwnershipScope {
  return { own: membershipId === null ? sql`false` : eq(signEnvelopes.senderMembershipId, membershipId) };
}

export async function resolveEnvelopeViewScope(
  access: AccessService,
  u: CurrentUserContext,
): Promise<ScopedRead> {
  return ScopedRead.for(access, u, SIGN_ENVELOPE_VIEW_PERMISSION);
}

/**
 * For reads the finalization pipeline makes on its own behalf, never for a
 * request. `ScopedRead` binds `orgId` at construction and these reads span many
 * orgs, so this is a per-call factory rather than the frozen constant it used to
 * be — the name stays the same so it is still greppable as one thing.
 */
export function systemEnvelopeScope(orgId: string): ScopedRead {
  return ScopedRead.of(orgId, "system", "all");
}

/**
 * Out of scope and out of tenant answer the same 404 a missing envelope answers:
 * a 403 here would confirm that the envelope exists.
 */
export async function mustGetVisibleEnvelope(
  db: Db,
  read: ScopedRead,
  membershipId: number | null,
  envelopeId: number,
  notFoundMessage: string,
) {
  return read.read(
    { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(membershipId), and: [eq(signEnvelopes.id, envelopeId)] },
    async ({ sql: where }) => {
      const envelope = await db.query.signEnvelopes.findFirst({ where });
      if (!envelope) throw new NotFoundException(notFoundMessage);
      return envelope;
    },
    () => {
      throw new NotFoundException(notFoundMessage);
    },
  );
}
