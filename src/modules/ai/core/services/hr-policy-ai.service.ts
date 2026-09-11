import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import { type Db } from "../../../../db/drizzle.module";
import { policyQaPrompt, policyQaStreamPrompt } from "../prompts/hr.prompts";
import {
  PolicyQaSchema,
  type PolicyQaResult,
} from "../dto/output.schemas";
import { AiGatewayService, type AiTextStream } from "../gateway/ai-gateway.service";
import { runInTenantTransaction } from "../../../../common/tenant/run-in-tenant-transaction";
import { unwrapAiResult } from "./gateway-result.util";
import { redactSensitiveData } from "../redaction.util";
import {
  HR_POLICY_AI_CAPABILITY,
  FORBIDDEN_HR_AI_ACTIONS,
  sanitizePolicyCitations,
  type PolicyEvidenceCitation,
} from "../lib/hr-ai-guardrails";

@Injectable()
export class HrPolicyAiService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Db,
    private readonly gateway: AiGatewayService,
  ) {}

  async policyQa(
    orgId: string,
    userId: string,
    question: string,
  ): Promise<
    PolicyQaResult & {
      suggestTicket: boolean;
      citations: PolicyEvidenceCitation[];
      capability: typeof HR_POLICY_AI_CAPABILITY;
      forbiddenActions: typeof FORBIDDEN_HR_AI_ACTIONS;
      advisory: true;
      disclaimer: string;
    }
  > {
    const safeQuestion = redactSensitiveData(question);

    const policies = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx.execute<{
          id: number;
          policy_type: string;
          name: string | null;
        }>(sql`
          SELECT id, policy_type, name
          FROM hr_policies
          WHERE org_id = ${orgId}
            AND status = 'active'
            AND deleted_at IS NULL
          ORDER BY priority DESC, created_at DESC
          LIMIT 20
        `);
        return rows.map((p) => ({
          id: Number(p.id),
          policyType: String(p.policy_type),
          scopeType: null,
          name: p.name ? String(p.name) : null,
        }));
      },
      { orgId },
    );

    const prompt = policyQaPrompt({ question: safeQuestion, policies });

    const result = await this.gateway.invokeStructured({
      actor: { orgId, userId },
      feature: "hr.policy-qa",
      prompt: {
        system: prompt.system,
        user: prompt.user,
        promptKey: "hr.policy_qa",
        promptVersion: 2,
      },
      schema: PolicyQaSchema,
      tier: "fast",
      maxTokens: 1024,
      charge: true,
    });

    const data = unwrapAiResult(result);
    const citations = sanitizePolicyCitations(data.citations ?? [], policies);
    const suggestTicket =
      data.confidence === "not_found" || data.shouldEscalate;
    return {
      ...data,
      citations,
      suggestTicket,
      capability: HR_POLICY_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_HR_AI_ACTIONS,
      advisory: true,
      disclaimer: HR_POLICY_AI_CAPABILITY.honestyLabel,
    };
  }

  async streamPolicyQa(
    orgId: string,
    userId: string,
    question: string,
    signal: AbortSignal,
  ): Promise<{ aiStream: AiTextStream; citations: PolicyEvidenceCitation[] }> {
    const safeQuestion = redactSensitiveData(question);

    const policies = await runInTenantTransaction(
      this.db,
      async (tx) => {
        const rows = await tx.execute<{
          id: number;
          policy_type: string;
          name: string | null;
        }>(sql`
          SELECT id, policy_type, name
          FROM hr_policies
          WHERE org_id = ${orgId}
            AND status = 'active'
            AND deleted_at IS NULL
          ORDER BY priority DESC, created_at DESC
          LIMIT 20
        `);
        return rows.map((p) => ({
          id: Number(p.id),
          policyType: String(p.policy_type),
          scopeType: null,
          name: p.name ? String(p.name) : null,
        }));
      },
      { orgId },
    );

    const prompt = policyQaStreamPrompt({ question: safeQuestion, policies });

    const aiStream = await this.gateway.streamTextWithUsage({
      actor: { orgId, userId },
      feature: "hr.policy-qa",
      prompt: { system: prompt.system, user: prompt.user },
      maxTokens: 1024,
      charge: true,
      signal,
    });

    const citations = sanitizePolicyCitations(
      policies.map((p) => ({ policyType: p.policyType, policyId: p.id, snippet: "" })),
      policies,
    );

    return { aiStream, citations };
  }

  policyQaCapabilities() {
    return {
      ...HR_POLICY_AI_CAPABILITY,
      forbiddenActions: FORBIDDEN_HR_AI_ACTIONS,
      features: [
        {
          key: "hr.policy-qa",
          mode: "answer_from_active_policies",
          requiresHumanEscalationWhenNotFound: true,
        },
      ],
    };
  }
}
