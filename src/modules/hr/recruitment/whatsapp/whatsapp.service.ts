import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { candidateMessages, candidates, organizations } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { AuditService } from "../../../../common/audit/audit.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { ProviderCredentialsService } from "../integrations/provider-credentials.service";
import {
  resolveProvider,
  type ProviderBlocked,
  type ProviderCredentials,
} from "../integrations/provider-blocked";
import { verifyVendorSignature } from "../integrations/vendor-signature";
import {
  decideSend,
  phoneMatchKey,
  renderTemplate,
  SEND_REFUSAL_COPY,
  type WhatsappTemplateKey,
} from "./whatsapp-consent";

export const WHATSAPP_PLATFORM = "WHATSAPP";

export interface WhatsappAdapter {
  send(
    credentials: ProviderCredentials,
    message: { to: string; template: string; body: string },
  ): Promise<{ reference: string }>;
}

/**
 * Empty, like every other provider in this lane.
 *
 * WhatsApp is the one where a stub is most tempting — the API is simple and a
 * fake send costs nothing — and most damaging, because a recruiter watching
 * "sent" appear against a candidate has no way to tell that the candidate's
 * phone never rang. Every send here either reaches a real vendor or refuses.
 */
export const WHATSAPP_ADAPTERS: ReadonlyMap<string, WhatsappAdapter> = new Map();

export function resolveWhatsapp(
  credentials: ProviderCredentials | null,
): { adapter: WhatsappAdapter; credentials: ProviderCredentials } | ProviderBlocked {
  return resolveProvider(
    WHATSAPP_PLATFORM,
    credentials,
    WHATSAPP_ADAPTERS,
    "WhatsApp messaging",
    "Message the candidate from your own WhatsApp Business account and log it as a note.",
  );
}

export interface WhatsappState {
  candidateId: number;
  optInAt: Date | null;
  optOutAt: Date | null;
  canSend: boolean;
  /** Why not, in words, when the answer is no. */
  refusal: string | null;
  providerBlockedReason: string | null;
}

@Injectable()
export class WhatsappService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly audit: AuditService,
    private readonly credentials: ProviderCredentialsService,
  ) {}

  async state(orgId: string, candidateId: number): Promise<WhatsappState> {
    const row = await this.candidate(orgId, candidateId);
    const decision = decideSend({ optInAt: row.whatsappOptInAt, optOutAt: row.whatsappOptOutAt });

    return {
      candidateId,
      optInAt: row.whatsappOptInAt,
      optOutAt: row.whatsappOptOutAt,
      canSend: decision.allowed,
      refusal: decision.allowed ? null : SEND_REFUSAL_COPY[decision.reason],
      providerBlockedReason: await this.blockedReason(orgId),
    };
  }

  /**
   * Records the candidate's decision about WhatsApp.
   *
   * Both directions write a timestamp rather than clearing the other one. A
   * withdrawal that erased the original opt-in would destroy the evidence that
   * consent was ever held, which is the record a DPDP complaint is answered
   * from.
   */
  async recordConsent(
    orgId: string,
    userId: string,
    candidateId: number,
    optedIn: boolean,
  ): Promise<WhatsappState> {
    await this.candidate(orgId, candidateId);
    const now = new Date();

    await this.db
      .update(candidates)
      .set(optedIn ? { whatsappOptInAt: now } : { whatsappOptOutAt: now })
      .where(and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)));

    await this.audit.logCritical({
      action: optedIn
        ? "hr.recruitment.whatsapp.opted_in"
        : "hr.recruitment.whatsapp.opted_out",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(candidateId),
    });

    return this.state(orgId, candidateId);
  }

  /**
   * Sends one of the approved templates.
   *
   * The consent gate runs before the provider is even resolved, so a tenant
   * with a live WhatsApp account still cannot message somebody who never agreed
   * — the ordering is what makes the gate a rule rather than a fallback.
   */
  async sendTemplate(
    orgId: string,
    userId: string,
    candidateId: number,
    template: WhatsappTemplateKey,
    variables: Record<string, string>,
  ): Promise<{ sent: true; reference: string }> {
    const row = await this.candidate(orgId, candidateId);

    const decision = decideSend({
      optInAt: row.whatsappOptInAt,
      optOutAt: row.whatsappOptOutAt,
    });
    if (!decision.allowed) throw new ForbiddenException(SEND_REFUSAL_COPY[decision.reason]);
    if (!row.phone) throw new BadRequestException("This candidate has no phone number on record.");

    const rendered = renderTemplate(template, variables);
    if (!rendered.ok) {
      throw new BadRequestException(
        `The template is missing ${rendered.missing.join(", ")}.`,
      );
    }

    const credentials = await this.credentials.forPlatform(orgId, WHATSAPP_PLATFORM);
    const resolved = resolveWhatsapp(credentials);
    if (!("adapter" in resolved)) throw new BadRequestException(resolved.message);

    const accepted = await resolved.adapter.send(resolved.credentials, {
      to: row.phone,
      template,
      body: rendered.body,
    });

    await this.db.insert(candidateMessages).values({
      orgId,
      candidateId,
      direction: "OUTBOUND",
      channel: "WHATSAPP",
      subject: template,
      body: rendered.body,
      sentBy: userId,
      sentAt: new Date(),
      externalId: accepted.reference,
    });

    await this.audit.logCritical({
      action: "hr.recruitment.whatsapp.sent",
      orgId,
      userId,
      resourceType: "candidate",
      resourceId: String(candidateId),
      metadata: { template, reference: accepted.reference },
    });

    return { sent: true, reference: accepted.reference };
  }

  /**
   * Records an inbound message as candidate activity.
   *
   * A reply is also an opt-in signal in practice, but it is not recorded as
   * one: somebody answering "who is this?" has not agreed to a campaign, and
   * inferring consent from contact is how an opt-in record stops meaning
   * anything.
   */
  async receiveInbound(
    orgSlug: string,
    rawBody: Buffer | string,
    signature: string | undefined,
  ): Promise<{ linked: boolean }> {
    const org = await this.db.query.organizations.findFirst({
      where: and(eq(organizations.slug, orgSlug), isNull(organizations.deletedAt)),
      columns: { id: true },
    });
    if (!org) throw new NotFoundException("Unknown organisation.");

    return runInTenantTransaction(
      this.db,
      async (tx) => {
        const credentials = await this.credentials.forPlatform(org.id, WHATSAPP_PLATFORM);
        const secret =
          credentials && typeof credentials.meta.inboundSecret === "string"
            ? credentials.meta.inboundSecret
            : null;
        if (!secret) throw new ForbiddenException("No callback secret is configured.");
        if (!verifyVendorSignature(rawBody, secret, signature)) {
          throw new ForbiddenException("Signature did not match.");
        }

        const payload: unknown = JSON.parse(
          typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"),
        );
        const parsed = inboundPayload(payload);
        if (!parsed) throw new BadRequestException("Inbound payload was not understood.");

        const key = phoneMatchKey(parsed.from);
        if (!key) return { linked: false };

        /*
          Scoped to this organisation and refused on more than one hit. Matching
          on the last ten digits is what makes four stored formats of the same
          Indian number comparable, and it is also why two people can collide —
          attaching a stranger's message to the wrong candidate's record is
          worse than not attaching it at all.
        */
        const matches = await tx
          .select({ id: candidates.id })
          .from(candidates)
          .where(
            and(
              eq(candidates.orgId, org.id),
              isNotNull(candidates.phone),
              sql`right(regexp_replace(${candidates.phone}, '\\D', '', 'g'), 10) = ${key}`,
            ),
          )
          .limit(2);
        if (matches.length !== 1) return { linked: false };

        const candidateId = matches[0]?.id;
        if (candidateId === undefined) return { linked: false };

        await tx.insert(candidateMessages).values({
          orgId: org.id,
          candidateId,
          direction: "INBOUND",
          channel: "WHATSAPP",
          body: parsed.text,
          sentAt: new Date(),
          externalId: parsed.messageId,
        });

        return { linked: true };
      },
      { orgId: org.id },
    );
  }

  private async candidate(orgId: string, candidateId: number) {
    const row = await this.db.query.candidates.findFirst({
      where: and(eq(candidates.id, candidateId), eq(candidates.orgId, orgId)),
      columns: {
        id: true,
        phone: true,
        whatsappOptInAt: true,
        whatsappOptOutAt: true,
      },
    });
    if (!row) throw new NotFoundException("Candidate not found.");
    return row;
  }

  private async blockedReason(orgId: string): Promise<string | null> {
    const credentials = await this.credentials.forPlatform(orgId, WHATSAPP_PLATFORM);
    const resolved = resolveWhatsapp(credentials);
    return "adapter" in resolved ? null : resolved.message;
  }
}

function inboundPayload(
  value: unknown,
): { from: string; text: string; messageId: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const { from, text, messageId } = value as Record<string, unknown>;
  if (typeof from !== "string" || from.length === 0 || from.length > 30) return null;
  if (typeof text !== "string" || text.length > 4096) return null;
  if (typeof messageId !== "string" || messageId.length === 0 || messageId.length > 200) return null;
  return { from, text, messageId };
}
