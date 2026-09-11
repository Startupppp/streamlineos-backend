import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { glParties, taxRegistrations } from "../../../db/schema";
import { DRIZZLE } from "../../../db/drizzle.constants";
import type { Db } from "../../../db/drizzle.module";
import { BooksService } from "../kernel/books.service";
import type { DbOrTx } from "../kernel/sequence.service";
import type {
  CreatePartyInput,
  CreateTaxRegistrationInput,
  ListPartiesQuery,
  UpdatePartyInput,
} from "./dto/parties.schemas";
import {
  findPartyIdByExternalRef,
  listPartyPage,
  listPartyRegistrations,
  loadPartyDetailRow,
} from "./lib/party-reads";
import { mergeRefs, partyInsertValues, partyPatch, regionFromNumber } from "./lib/party-writes";
import type {
  ExternalRef,
  PartyDetail,
  PartyPage,
  PartyTaxRegistration,
} from "./parties.types";

export type {
  ExternalRef,
  PartyDetail,
  PartyPage,
  PartySummary,
  PartyTaxRegistration,
} from "./parties.types";

/**
 * The party master — customers and vendors in one table.
 *
 * AR and AP both consume this service; nothing here knows which one is calling.
 * `role` says what a party may be used for and is widened rather than
 * duplicated, so billing a company you also buy from does not create a second
 * identity.
 *
 * The `external_refs` pointer is the interesting part. CRM owns the company
 * record; accounting owns the party. `resolveOrCreateByExternalRef` is the only
 * bridge, and it is idempotent, which is what makes "a CRM company maps to
 * exactly one customer" true rather than aspirational (PRD 07 acceptance 5).
 */
@Injectable()
export class PartiesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly books: BooksService,
  ) {}

  /* ----------------------------------------------------------------- read */

  async list(orgId: string, query: ListPartiesQuery = {}): Promise<PartyPage> {
    const book = await this.books.requireDefault(orgId);
    return listPartyPage(this.db, orgId, book.id, query);
  }

  /** Cross-tenant ids resolve to 404, never 403 (backend/CLAUDE.md §4). */
  async get(orgId: string, partyId: string, tx: DbOrTx = this.db): Promise<PartyDetail> {
    const row = await loadPartyDetailRow(tx, orgId, partyId);
    return { ...row, taxRegistrations: await this.listRegistrations(orgId, partyId, tx) };
  }

  /**
   * The lookup AR and AP use before putting a party on a document — same 404
   * semantics, but it also proves the party belongs to the book being posted to.
   */
  async requireForBook(
    orgId: string,
    bookId: string,
    partyId: string,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail> {
    const party = await this.get(orgId, partyId, tx);
    if (party.bookId !== bookId) throw new NotFoundException("Party not found");
    return party;
  }

  /* ---------------------------------------------------------------- write */

  async create(orgId: string, userId: string | null, input: CreatePartyInput): Promise<PartyDetail> {
    const book = await this.books.requireDefault(orgId);
    return this.createInBook(orgId, book.id, userId, input);
  }

  private async createInBook(
    orgId: string,
    bookId: string,
    userId: string | null,
    input: CreatePartyInput,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail> {
    const [created] = await tx
      .insert(glParties)
      .values(partyInsertValues(orgId, bookId, userId, input))
      .returning({ id: glParties.id });

    if (!created) throw new ConflictException("Could not create the party");
    return this.get(orgId, created.id, tx);
  }

  async update(orgId: string, partyId: string, patch: UpdatePartyInput): Promise<PartyDetail> {
    await this.get(orgId, partyId);

    const values = partyPatch(patch);
    if (Object.keys(values).length > 0) {
      await this.db
        .update(glParties)
        .set(values)
        .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    }

    return this.get(orgId, partyId);
  }

  /** Soft delete — a party on a posted document must stay resolvable forever. */
  async remove(orgId: string, partyId: string): Promise<{ id: string; deleted: true }> {
    await this.get(orgId, partyId);
    await this.db
      .update(glParties)
      .set({ deletedAt: new Date(), isActive: false })
      .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    return { id: partyId, deleted: true };
  }

  /* ------------------------------------------------------- external refs */

  /**
   * Find the party this external record already maps to, or create it.
   *
   * Two callers racing on the same CRM company would both miss the lookup and
   * both insert, so the read and the write are serialised on a transaction-scoped
   * advisory lock keyed by `(book, system, id)`. The lock is released at commit;
   * nothing outside this transaction ever waits on it.
   */
  async resolveOrCreateByExternalRef(
    orgId: string,
    bookId: string,
    ref: ExternalRef,
    fields: CreatePartyInput,
    userId: string | null = null,
    tx?: DbOrTx,
  ): Promise<PartyDetail> {
    const run = async (t: DbOrTx): Promise<PartyDetail> => {
      const lockKey = `gl_parties:${bookId}:${ref.system}:${ref.id}`;
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${lockKey}), 0)`);

      const existing = await this.findByExternalRef(orgId, bookId, ref, t);
      if (existing) return this.widenRole(orgId, existing, fields.role, t);

      const created = await this.createInBook(
        orgId,
        bookId,
        userId,
        {
          ...fields,
          externalRefs: mergeRefs(fields.externalRefs ?? [], ref),
        },
        t,
      );
      return created;
    };

    return tx ? run(tx) : this.db.transaction((t) => run(t));
  }

  async findByExternalRef(
    orgId: string,
    bookId: string,
    ref: ExternalRef,
    tx: DbOrTx = this.db,
  ): Promise<PartyDetail | null> {
    const partyId = await findPartyIdByExternalRef(tx, orgId, bookId, ref);
    return partyId ? this.get(orgId, partyId, tx) : null;
  }

  /** Attach a pointer to an existing party without disturbing the others. */
  async linkExternalRef(orgId: string, partyId: string, ref: ExternalRef): Promise<PartyDetail> {
    const party = await this.get(orgId, partyId);
    const merged = mergeRefs(party.externalRefs, ref);
    if (merged.length !== party.externalRefs.length) {
      await this.db
        .update(glParties)
        .set({ externalRefs: merged })
        .where(and(eq(glParties.orgId, orgId), eq(glParties.id, partyId)));
    }
    return this.get(orgId, partyId);
  }

  /**
   * A vendor the sales team just invoiced is not a second company — it is the
   * same party in both roles. Widening never narrows.
   */
  private async widenRole(
    orgId: string,
    party: PartyDetail,
    wanted: CreatePartyInput["role"],
    tx: DbOrTx,
  ): Promise<PartyDetail> {
    if (!wanted || wanted === party.role || party.role === "both") return party;
    await tx
      .update(glParties)
      .set({ role: "both" })
      .where(and(eq(glParties.orgId, orgId), eq(glParties.id, party.id)));
    return this.get(orgId, party.id, tx);
  }

  /* --------------------------------------------------- tax registrations */

  async listRegistrations(
    orgId: string,
    partyId: string,
    tx: DbOrTx = this.db,
  ): Promise<PartyTaxRegistration[]> {
    return listPartyRegistrations(tx, orgId, partyId);
  }

  /**
   * Registrations hang off the party, not off the document, so a customer's
   * GSTIN is entered once and every future invoice determines against it.
   */
  async addRegistration(
    orgId: string,
    partyId: string,
    input: CreateTaxRegistrationInput,
  ): Promise<PartyTaxRegistration> {
    await this.get(orgId, partyId);
    if (input.validFrom && input.validTo && input.validTo < input.validFrom) {
      throw new BadRequestException("validTo cannot be earlier than validFrom");
    }

    const number = input.number.trim().toUpperCase();
    const existing = await this.listRegistrations(orgId, partyId);
    if (existing.some((r) => r.regime === input.regime && r.number === number)) {
      throw new ConflictException(`${input.regime} ${number} is already recorded for this party`);
    }

    const [created] = await this.db
      .insert(taxRegistrations)
      .values({
        orgId,
        ownerType: "party",
        bookId: null,
        partyId,
        regime: input.regime,
        number,
        // India reads the state from the first two digits of a GSTIN; anywhere
        // else the caller supplies it. Either way the engine gets a region.
        region: input.region ?? regionFromNumber(input.regime, number),
        countryCode: input.countryCode.toUpperCase(),
        isPrimary: input.isPrimary ?? existing.length === 0,
        validFrom: input.validFrom ?? null,
        validTo: input.validTo ?? null,
      })
      .returning({ id: taxRegistrations.id });

    if (!created) throw new ConflictException("Could not record the tax registration");
    const saved = (await this.listRegistrations(orgId, partyId)).find((r) => r.id === created.id);
    if (!saved) throw new ConflictException("Could not record the tax registration");
    return saved;
  }

  async removeRegistration(
    orgId: string,
    partyId: string,
    registrationId: string,
  ): Promise<{ id: string; deleted: true }> {
    await this.get(orgId, partyId);
    const deleted = await this.db
      .delete(taxRegistrations)
      .where(
        and(
          eq(taxRegistrations.orgId, orgId),
          eq(taxRegistrations.id, registrationId),
          eq(taxRegistrations.ownerType, "party"),
          eq(taxRegistrations.partyId, partyId),
        ),
      )
      .returning({ id: taxRegistrations.id });

    if (deleted.length === 0) throw new NotFoundException("Tax registration not found");
    return { id: registrationId, deleted: true };
  }
}
