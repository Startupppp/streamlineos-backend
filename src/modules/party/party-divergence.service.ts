import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.types";
import {
  businessParties,
  clientPartyMap,
  contactPartyMap,
  leadPartyMap,
} from "../../db/schema/party";
import { clients, contacts } from "../../db/schema/crm/contacts";
import { leads } from "../../db/schema/crm/leads";
import {
  diffLegacyMirror,
  mirroredColumns,
  type MirrorFieldDivergence,
  type PartyRow,
} from "./party-legacy-mirror";
import {
  countUnmappedLegacyRows,
  MAPPED_LEGACY_KINDS,
  type MappedLegacyKind,
} from "./party-legacy-seam";

/**
 * What the mirror actually looks like, on demand.
 *
 * A report, never a repair. Rewriting whichever side looks wrong would make the
 * numbers go green and destroy the only evidence of how the two came apart —
 * which write path, which column, in which direction — and that evidence is the
 * entire reason to look. Fixing a row is a deliberate act performed afterwards,
 * with the report in hand.
 *
 * Three failure modes, kept apart because they mean different things:
 *
 * A **divergent** row disagrees with its Party. Somewhere a legacy write did not
 * go through `party-legacy-writer`, or a Party write did not refresh its mirror.
 *
 * An **unmapped** row has no Party at all. 0241 made that impossible for
 * everything that existed when it ran, so a non-zero count means rows arrived
 * out of band — a restore, a direct import, a module writing the legacy table
 * without the seam.
 *
 * An **unexpressible deletion** is a Party that is soft-deleted while its client
 * mirror is not, and cannot be: `clients` has no `deleted_at`. Reported rather
 * than repaired for the same reason as everything else here, and separately from
 * a divergence because no write path can fix it — only dropping the table can.
 */

export interface DivergentMirrorRow {
  readonly kind: MappedLegacyKind;
  readonly legacyId: number;
  readonly partyId: string;
  readonly fields: readonly MirrorFieldDivergence[];
}

export interface UnexpressibleDeletion {
  readonly kind: MappedLegacyKind;
  readonly legacyId: number;
  readonly partyId: string;
  readonly reason: string;
}

export interface MirrorDivergenceReport {
  readonly checkedAt: string;
  readonly organizationId: string;
  readonly scanned: Record<MappedLegacyKind, number>;
  readonly divergentCount: Record<MappedLegacyKind, number>;
  readonly unmapped: Record<MappedLegacyKind, number>;
  readonly divergent: readonly DivergentMirrorRow[];
  readonly unexpressibleDeletions: readonly UnexpressibleDeletion[];
  /** True when a kind hit `limit`; the next call passes `after` for that kind. */
  readonly truncated: boolean;
  readonly nextAfter: Record<MappedLegacyKind, number | null>;
}

export interface DivergenceScanOptions {
  readonly kinds?: readonly MappedLegacyKind[];
  readonly limit?: number;
  readonly after?: Partial<Record<MappedLegacyKind, number>>;
}

interface JoinedRow {
  readonly legacyId: number;
  readonly party: PartyRow;
  readonly legacy: Record<string, unknown>;
}

const DEFAULT_LIMIT = 200;

@Injectable()
export class PartyDivergenceService {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async report(
    organizationId: string,
    options: DivergenceScanOptions = {},
  ): Promise<MirrorDivergenceReport> {
    const kinds = options.kinds ?? MAPPED_LEGACY_KINDS;
    const limit = options.limit ?? DEFAULT_LIMIT;

    const scanned: Record<MappedLegacyKind, number> = { LEAD: 0, CLIENT: 0, CONTACT: 0 };
    const divergentCount: Record<MappedLegacyKind, number> = { LEAD: 0, CLIENT: 0, CONTACT: 0 };
    const nextAfter: Record<MappedLegacyKind, number | null> = {
      LEAD: null,
      CLIENT: null,
      CONTACT: null,
    };
    const divergent: DivergentMirrorRow[] = [];
    let truncated = false;

    for (const kind of kinds) {
      const rows = await this.scan(organizationId, kind, limit, options.after?.[kind] ?? 0);
      scanned[kind] = rows.length;
      if (rows.length === limit) {
        truncated = true;
        nextAfter[kind] = rows[rows.length - 1]?.legacyId ?? null;
      }
      for (const row of rows) {
        const fields = diffLegacyMirror(kind, row.party, row.legacy);
        if (fields.length === 0) continue;
        divergentCount[kind] += 1;
        divergent.push({ kind, legacyId: row.legacyId, partyId: row.party.partyId, fields });
      }
    }

    const [unmapped, unexpressibleDeletions] = await Promise.all([
      countUnmappedLegacyRows(this.db, organizationId),
      this.findUnexpressibleDeletions(organizationId, limit),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      organizationId,
      scanned,
      divergentCount,
      unmapped,
      divergent,
      unexpressibleDeletions,
      truncated,
      nextAfter,
    };
  }

  /**
   * The mirror columns for one kind, and where each came from.
   *
   * Read straight off the derivation, so an operator reading a report can see
   * the same field map the writer uses rather than a documented copy of it.
   */
  describeMirror(): Record<MappedLegacyKind, readonly string[]> {
    return {
      LEAD: mirroredColumns("LEAD"),
      CLIENT: mirroredColumns("CLIENT"),
      CONTACT: mirroredColumns("CONTACT"),
    };
  }

  /**
   * One indexed pass per kind, ordered by legacy id so a truncated scan resumes.
   *
   * The tenant is asserted on the map row *and* on both tables it joins, matching
   * `party-legacy-seam`: a map row must not be able to reach a party or a legacy
   * record in another organisation even if its columns were tampered with.
   */
  private async scan(
    organizationId: string,
    kind: MappedLegacyKind,
    limit: number,
    after: number,
  ): Promise<JoinedRow[]> {
    if (kind === "LEAD") {
      const rows = await this.db
        .select({ legacyId: leadPartyMap.leadId, party: businessParties, legacy: leads })
        .from(leadPartyMap)
        .innerJoin(
          businessParties,
          and(
            eq(businessParties.partyId, leadPartyMap.partyId),
            eq(businessParties.organizationId, leadPartyMap.organizationId),
          ),
        )
        .innerJoin(
          leads,
          and(eq(leads.id, leadPartyMap.leadId), eq(leads.orgId, leadPartyMap.organizationId)),
        )
        .where(
          and(eq(leadPartyMap.organizationId, organizationId), gt(leadPartyMap.leadId, after)),
        )
        .orderBy(asc(leadPartyMap.leadId))
        .limit(limit);
      return rows.map((row) => ({ legacyId: row.legacyId, party: row.party, legacy: row.legacy }));
    }

    if (kind === "CLIENT") {
      const rows = await this.db
        .select({ legacyId: clientPartyMap.clientId, party: businessParties, legacy: clients })
        .from(clientPartyMap)
        .innerJoin(
          businessParties,
          and(
            eq(businessParties.partyId, clientPartyMap.partyId),
            eq(businessParties.organizationId, clientPartyMap.organizationId),
          ),
        )
        .innerJoin(
          clients,
          and(
            eq(clients.id, clientPartyMap.clientId),
            eq(clients.orgId, clientPartyMap.organizationId),
          ),
        )
        .where(
          and(eq(clientPartyMap.organizationId, organizationId), gt(clientPartyMap.clientId, after)),
        )
        .orderBy(asc(clientPartyMap.clientId))
        .limit(limit);
      return rows.map((row) => ({ legacyId: row.legacyId, party: row.party, legacy: row.legacy }));
    }

    const rows = await this.db
      .select({ legacyId: contactPartyMap.contactId, party: businessParties, legacy: contacts })
      .from(contactPartyMap)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, contactPartyMap.partyId),
          eq(businessParties.organizationId, contactPartyMap.organizationId),
        ),
      )
      .innerJoin(
        contacts,
        and(
          eq(contacts.id, contactPartyMap.contactId),
          eq(contacts.orgId, contactPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(contactPartyMap.organizationId, organizationId),
          gt(contactPartyMap.contactId, after),
        ),
      )
      .orderBy(asc(contactPartyMap.contactId))
      .limit(limit);
    return rows.map((row) => ({ legacyId: row.legacyId, party: row.party, legacy: row.legacy }));
  }

  /**
   * Deleted parties whose client mirror cannot say so.
   *
   * `clients` has no `deleted_at`, so this is not something a write path failed
   * to do — it is something the legacy shape cannot express. It is listed
   * separately for exactly that reason: counting it as divergence would put a
   * permanent floor under the number and teach everyone to ignore it.
   */
  private async findUnexpressibleDeletions(
    organizationId: string,
    limit: number,
  ): Promise<UnexpressibleDeletion[]> {
    const rows = await this.db
      .select({ legacyId: clientPartyMap.clientId, partyId: clientPartyMap.partyId })
      .from(clientPartyMap)
      .innerJoin(
        businessParties,
        and(
          eq(businessParties.partyId, clientPartyMap.partyId),
          eq(businessParties.organizationId, clientPartyMap.organizationId),
        ),
      )
      .innerJoin(
        clients,
        and(
          eq(clients.id, clientPartyMap.clientId),
          eq(clients.orgId, clientPartyMap.organizationId),
        ),
      )
      .where(
        and(
          eq(clientPartyMap.organizationId, organizationId),
          isNotNull(businessParties.deletedAt),
        ),
      )
      .orderBy(asc(clientPartyMap.clientId))
      .limit(limit);

    return rows.map((row) => ({
      kind: "CLIENT" as const,
      legacyId: row.legacyId,
      partyId: row.partyId,
      reason: "`clients` has no deleted_at column, so the mirror cannot record the deletion",
    }));
  }
}
