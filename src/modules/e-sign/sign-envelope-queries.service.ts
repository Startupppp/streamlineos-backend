import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { and, count, eq, type SQL } from "drizzle-orm";
import {
  signDocuments,
  signEnvelopes,
  signEnvelopeStatusEnum,
  signFields,
} from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { SignRecipientsService } from "./sign-recipients.service";
import { envelopeSenderScope, systemEnvelopeScope } from "./sign-envelope-scope";
import type { ScopedRead } from "../access/scoped-read";
import { buildListResponse } from "../../common/pagination/pagination";
import type { ListEnvelopesInput } from "./dto/e-sign.schemas";
import type { SignEnvelopeStatus } from "./sign-state";

function isSignEnvelopeStatus(value: string): value is SignEnvelopeStatus {
  return signEnvelopeStatusEnum.enumValues.some((status) => status === value);
}

@Injectable()
export class SignEnvelopeQueriesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly recipients: SignRecipientsService,
  ) {}

  private async mustGet(orgId: string, envelopeId: number) {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(
        eq(signEnvelopes.id, envelopeId),
        eq(signEnvelopes.orgId, orgId),
      ),
    });
    if (!envelope) throw new NotFoundException("Envelope not found");
    return envelope;
  }

  async list(
    read: ScopedRead,
    membershipId: number | null,
    query: ListEnvelopesInput,
  ) {
    const pageParams = { page: query.page, pageSize: query.limit };
    const domain: SQL[] = [];
    if (query.status) {
      if (!isSignEnvelopeStatus(query.status)) {
        throw new BadRequestException(
          `Invalid envelope status: ${query.status}`,
        );
      }
      domain.push(eq(signEnvelopes.status, query.status));
    }
    if (query.sourceModule)
      domain.push(eq(signEnvelopes.sourceModule, query.sourceModule));
    if (query.sourceEntityType)
      domain.push(
        eq(signEnvelopes.sourceEntityType, query.sourceEntityType),
      );
    if (query.sourceEntityId)
      domain.push(eq(signEnvelopes.sourceEntityId, query.sourceEntityId));

    return read.read(
      { tenant: signEnvelopes.orgId, scope: envelopeSenderScope(membershipId), and: domain },
      async ({ sql: where }) => {
        const [rows, [totalRow]] = await Promise.all([
          this.db.query.signEnvelopes.findMany({
            where,
            orderBy: (e, { desc }) => [desc(e.createdAt)],
            limit: query.limit,
            offset: (query.page - 1) * query.limit,
          }),
          this.db.select({ total: count() }).from(signEnvelopes).where(where),
        ]);

        return buildListResponse(rows, Number(totalRow?.total ?? 0), pageParams);
      },
      () => buildListResponse([], 0, pageParams),
    );
  }

  async getFull(read: ScopedRead, membershipId: number | null, envelopeId: number) {
    const orgId = read.orgId;
    const envelope = await this.mustGet(orgId, envelopeId);
    // Kept as an application-level check, not a `mustGetVisibleEnvelope` predicate:
    // this endpoint has always answered a same-tenant, out-of-scope envelope with
    // 403 (never the 404 that a row-filter miss would produce), so the raw value is
    // read here rather than folding this into the shared 404-only helper.
    if (!read.unrestricted && (membershipId == null || envelope.senderMembershipId !== membershipId)) {
      throw new ForbiddenException("Not authorized to view this envelope");
    }
    const [documents, recipientRows, fields] = await Promise.all([
      this.db.query.signDocuments.findMany({
        where: and(
          eq(signDocuments.orgId, orgId),
          eq(signDocuments.envelopeId, envelopeId),
        ),
        orderBy: (d, { asc }) => [asc(d.orderIndex)],
      }),
      this.recipients.listForEnvelope(systemEnvelopeScope(orgId), null, envelopeId),
      this.db.query.signFields.findMany({
        where: and(
          eq(signFields.orgId, orgId),
          eq(signFields.envelopeId, envelopeId),
        ),
      }),
    ]);
    return { envelope, documents, recipients: recipientRows, fields };
  }
}
