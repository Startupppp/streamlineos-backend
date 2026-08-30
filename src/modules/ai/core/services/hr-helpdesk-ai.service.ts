import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { helpdeskTickets, users } from "../../../../db/schema";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { helpdeskReplyPrompt, letterDraftPrompt } from "../prompts/hr.prompts";
import {
  HelpdeskReplySchema,
  LetterDraftSchema,
  type HelpdeskReplyResult,
  type LetterDraftResult,
} from "../dto/output.schemas";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { unwrapAiResult } from "./gateway-result.util";
import { redactSensitiveData } from "../redaction.util";

@Injectable()
export class HrHelpdeskAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async suggestHelpdeskReply(
    orgId: string,
    ticketId: number,
  ): Promise<HelpdeskReplyResult | null> {
    const ticket = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const [row] = await tx
          .select({
            title: helpdeskTickets.title,
            description: helpdeskTickets.description,
            category: helpdeskTickets.category,
            priority: helpdeskTickets.priority,
            userId: helpdeskTickets.userId,
            employeeName: users.name,
          })
          .from(helpdeskTickets)
          .leftJoin(users, eq(helpdeskTickets.userId, users.id))
          .where(
            and(eq(helpdeskTickets.id, ticketId), eq(helpdeskTickets.orgId, orgId)),
          );
        return row ?? null;
      },
      { orgId },
    );
    if (!ticket) return null;

    const prompt = helpdeskReplyPrompt({
      ticketTitle: ticket.title,
      ticketDescription: ticket.description,
      category: ticket.category,
      priority: ticket.priority,
      employeeName: ticket.employeeName,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: ticket.userId ?? null },
      feature: "hr.helpdesk-reply",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.helpdesk_reply",
        promptVersion: 1,
      },
      schema: HelpdeskReplySchema,
      tier: "fast",
      maxTokens: 768,
      charge: true,
    });

    return unwrapAiResult(result);
  }

  async draftLetter(
    orgId: string,
    _: string,
    targetUserId: string,
    letterType: string,
    details: string | null,
  ): Promise<LetterDraftResult | null> {
    const ctx = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const empRows = await tx.execute(sql`
          SELECT p.first_name, p.last_name, e.designation
          FROM hr_employments e
          JOIN hr_people p ON p.id = e.person_id
          WHERE e.org_id = ${orgId}
            AND p.user_id = ${targetUserId}
            AND e.deleted_at IS NULL
          LIMIT 1
        `);

        if (empRows.length > 0) {
          const emp = empRows[0] as Record<string, unknown>;
          return {
            employeeName: `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim(),
            currentTitle: emp.designation ? String(emp.designation) : null,
          };
        }

        const [userRow] = await tx
          .select({ name: users.name })
          .from(users)
          .where(eq(users.id, targetUserId));
        if (!userRow) return null;
        return {
          employeeName: userRow.name ?? targetUserId,
          currentTitle: null,
        };
      },
      { orgId },
    );
    if (!ctx) return null;

    const { employeeName, currentTitle } = ctx;

    const safeDetails = details ? redactSensitiveData(details) : null;
    const prompt = letterDraftPrompt({
      letterType,
      employeeName,
      currentTitle,
      details: safeDetails,
    });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId: targetUserId },
      feature: "hr.letter-draft",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.letter_draft",
        promptVersion: 1,
      },
      schema: LetterDraftSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    return unwrapAiResult(result);
  }
}
