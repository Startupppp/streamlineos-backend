import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { signDocuments, signEnvelopes } from "../../db/schema";
import { DRIZZLE } from "../../db/drizzle.constants";
import { type Db } from "../../db/drizzle.module";
import { StorageService } from "../storage/storage.service";
import { AiGatewayService } from "../ai/core/gateway/ai-gateway.service";
import { unwrapAiResult } from "../ai/core/services/gateway-result.util";
import { extractAttachmentText } from "../kb/retrieval/kb-attachment-extract.util";

const SIGN_SUMMARIZE_FEATURE = "sign.summarize-document";
const MAX_DOCS = 2;
const TEXT_CAP = 6_000;

@Injectable()
export class SignAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly storage: StorageService,
    private readonly gateway: AiGatewayService,
  ) {}

  async summarizeDocument(
    orgId: string,
    envelopeId: number,
    userId: string,
  ): Promise<{ summary: string }> {
    const envelope = await this.db.query.signEnvelopes.findFirst({
      where: and(eq(signEnvelopes.id, envelopeId), eq(signEnvelopes.orgId, orgId)),
    });

    if (!envelope) {
      throw new NotFoundException("Envelope not found");
    }

    const docs = await this.db.query.signDocuments.findMany({
      where: and(eq(signDocuments.orgId, orgId), eq(signDocuments.envelopeId, envelopeId)),
      orderBy: (d, { asc }) => [asc(d.orderIndex)],
    });

    if (docs.length === 0) {
      return { summary: "No documents attached to this envelope." };
    }

    const textParts: string[] = [];

    for (const doc of docs.slice(0, MAX_DOCS)) {
      const stream = await this.storage.getFileStream(doc.orgId, doc.currentFileKey);
      const chunks: Buffer[] = [];

      for await (const chunk of stream.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }

      const buffer = Buffer.concat(chunks);
      const text = await extractAttachmentText(buffer, doc.mimeType);

      if (text.trim().length > 0) {
        textParts.push(text);
      }
    }

    const combined = textParts.join("\n\n").slice(0, TEXT_CAP);

    if (combined.trim().length === 0) {
      return { summary: "Could not extract text from the attached documents." };
    }

    const result = await this.gateway.invokeText({
      actor: { orgId, userId },
      feature: SIGN_SUMMARIZE_FEATURE,
      prompt: {
        system:
          "You are a legal assistant summarizing an agreement for a non-lawyer. Be clear, plain, and concise.",
        user: `Summarize the key terms of this agreement in plain English. Focus on: parties involved, obligations, payment terms if any, deadlines, termination conditions, and any unusual clauses.\n\nDocument text:\n${combined}`,
      },
      tier: "standard",
      maxTokens: 600,
      charge: true,
    });

    const summary = unwrapAiResult(result);

    return { summary };
  }
}
