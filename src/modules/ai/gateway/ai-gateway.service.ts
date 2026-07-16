import { BadRequestException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import { z, ZodError } from "zod";
import { LlmService } from "../providers/llm.service";
import { AiUsageService } from "../services/ai-usage.service";
import { AuditService } from "../../../common/audit/audit.service";
import { redactSensitiveData } from "../redaction.util";
import { AI_CREDIT_LEDGER, type AiCreditLedger } from "./credit-ledger.interface";
import type {
  AiInvokeResult,
  AiInvokeFailure,
  AiInvokeBaseOpts,
} from "./ai-gateway.types";

interface InvokeStructuredOpts<T> extends AiInvokeBaseOpts {
  schema: z.ZodType<T>;
}

type InvokeTextOpts = AiInvokeBaseOpts;

type ReserveResult =
  | { reserved: true; reservationId: number }
  | { reserved: false; correlationId: string; kind: AiInvokeFailure["kind"]; message: string };

@Injectable()
export class AiGatewayService {
  private readonly inflightMap = new Map<string, Promise<AiInvokeResult<unknown>>>();

  constructor(
    private readonly llm: LlmService,
    private readonly usageSvc: AiUsageService,
    private readonly audit: AuditService,
    @Inject(AI_CREDIT_LEDGER) private readonly ledger: AiCreditLedger,
  ) {}

  async invokeStructured<T>(opts: InvokeStructuredOpts<T>): Promise<AiInvokeResult<T>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<T>>;
    }

    const promise = this.runStructured(opts, correlationId);

    if (dedupeKey) {
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
    }

    return promise;
  }

  async invokeText(opts: InvokeTextOpts): Promise<AiInvokeResult<string>> {
    const correlationId = randomUUID();
    const dedupeKey = opts.dedupe ? buildDedupeKey(opts) : null;

    if (dedupeKey) {
      const inflight = this.inflightMap.get(dedupeKey);
      if (inflight) return inflight as Promise<AiInvokeResult<string>>;
    }

    const promise = this.runText(opts, correlationId);

    if (dedupeKey) {
      this.inflightMap.set(dedupeKey, promise as Promise<AiInvokeResult<unknown>>);
      promise.finally(() => this.inflightMap.delete(dedupeKey)).catch(() => undefined);
    }

    return promise;
  }

  private async runStructured<T>(opts: InvokeStructuredOpts<T>, correlationId: string): Promise<AiInvokeResult<T>> {
    const { actor, feature, tier, maxTokens, charge, redact = true } = opts;
    const prompt = redact
      ? { system: redactSensitiveData(opts.prompt.system), user: redactSensitiveData(opts.prompt.user) }
      : opts.prompt;

    let reservationId = 0;

    if (charge) {
      const reserveResult = await this.reserveCredits(charge, actor, feature, correlationId);
      if (!reserveResult.reserved) return { ok: false, kind: reserveResult.kind, message: reserveResult.message, correlationId: reserveResult.correlationId };
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await this.llm.invokeStructuredWithUsage({
        model: tier ?? "fast",
        schema: opts.schema,
        schemaName: feature.replace(/[^a-z0-9]/gi, "_"),
        system: prompt.system,
        user: prompt.user,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      await this.settleAndTrack(reservationId, charge, result.model, usage, actor, feature, opts.prompt, correlationId, latencyMs, "ok");

      return {
        ok: true,
        data: result.data,
        model: result.model,
        latencyMs,
        correlationId,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return this.handleProviderError(error, reservationId, actor, feature, opts.prompt, correlationId, latencyMs);
    }
  }

  private async runText(opts: InvokeTextOpts, correlationId: string): Promise<AiInvokeResult<string>> {
    const { actor, feature, tier, maxTokens, charge, redact = true } = opts;
    const prompt = redact
      ? { system: redactSensitiveData(opts.prompt.system), user: redactSensitiveData(opts.prompt.user) }
      : opts.prompt;

    let reservationId = 0;

    if (charge) {
      const reserveResult = await this.reserveCredits(charge, actor, feature, correlationId);
      if (!reserveResult.reserved) return { ok: false, kind: reserveResult.kind, message: reserveResult.message, correlationId: reserveResult.correlationId };
      reservationId = reserveResult.reservationId;
    }

    const start = Date.now();

    try {
      const result = await this.llm.invokeTextWithUsage({
        model: tier ?? "fast",
        system: prompt.system,
        user: prompt.user,
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      });

      const latencyMs = Date.now() - start;
      const usage = result.usage;

      await this.settleAndTrack(reservationId, charge, result.model, usage, actor, feature, opts.prompt, correlationId, latencyMs, "ok");

      return {
        ok: true,
        data: result.text,
        model: result.model,
        latencyMs,
        correlationId,
        usage: {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
        },
      };
    } catch (error) {
      const latencyMs = Date.now() - start;
      return this.handleProviderError(error, reservationId, actor, feature, opts.prompt, correlationId, latencyMs);
    }
  }

  private async reserveCredits(
    charge: NonNullable<AiInvokeBaseOpts["charge"]>,
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    correlationId: string,
  ): Promise<ReserveResult> {
    try {
      const { reservationId } = await this.ledger.reserve({
        orgId: actor.orgId,
        userId: actor.userId,
        feature,
        credits: charge.credits,
        idempotencyKey: charge.idempotencyKey,
      });
      return { reserved: true, reservationId };
    } catch (error) {
      if (error instanceof BadRequestException) {
        const msg = error.message ?? "Insufficient AI credits";
        if (msg.includes("Insufficient AI credits")) {
          return { reserved: false, correlationId, kind: "quota_exceeded", message: msg };
        }
      }
      throw error;
    }
  }

  private async settleAndTrack(
    reservationId: number,
    charge: AiInvokeBaseOpts["charge"],
    model: string,
    usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null },
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    prompt: AiInvokeBaseOpts["prompt"],
    correlationId: string,
    latencyMs: number,
    outcome: "ok" | "error",
  ): Promise<void> {
    if (charge && reservationId !== 0) {
      void this.ledger
        .settle(reservationId, { actualCredits: charge.credits, model })
        .catch(() => undefined);
    }

    void this.usageSvc
      .track({
        orgId: actor.orgId,
        userId: actor.userId,
        feature,
        model,
        promptTokens: usage.promptTokens ?? undefined,
        completionTokens: usage.completionTokens ?? undefined,
        metadata: { correlationId, latencyMs },
      })
      .catch(() => undefined);

    this.audit.log({
      action: "ai.invoke",
      userId: actor.userId ?? "system",
      orgId: actor.orgId,
      metadata: {
        feature,
        model,
        promptKey: prompt.promptKey,
        promptVersion: prompt.promptVersion,
        correlationId,
        latencyMs,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        outcome,
      },
    });
  }

  private async handleProviderError(
    error: unknown,
    reservationId: number,
    actor: AiInvokeBaseOpts["actor"],
    feature: string,
    prompt: AiInvokeBaseOpts["prompt"],
    correlationId: string,
    latencyMs: number,
  ): Promise<AiInvokeResult<never>> {
    if (error instanceof ZodError) {
      if (reservationId !== 0) {
        void this.ledger.release(reservationId, "invalid_output").catch(() => undefined);
      }
      await this.settleAndTrack(0, undefined, "unknown", { promptTokens: null, completionTokens: null, totalTokens: null }, actor, feature, prompt, correlationId, latencyMs, "error");
      return { ok: false, kind: "invalid_output", message: "AI response did not match expected format", correlationId };
    }

    if (reservationId !== 0) {
      void this.ledger.release(reservationId, "provider_error").catch(() => undefined);
    }

    const message = error instanceof ServiceUnavailableException ? error.message : "AI provider is temporarily unavailable";
    const kind = message.toLowerCase().includes("not configured") ? "not_configured" : "provider_unavailable";

    await this.settleAndTrack(0, undefined, "unknown", { promptTokens: null, completionTokens: null, totalTokens: null }, actor, feature, prompt, correlationId, latencyMs, "error");

    return { ok: false, kind, message, correlationId };
  }
}

function buildDedupeKey(opts: AiInvokeBaseOpts): string {
  const content = opts.prompt.system + opts.prompt.user;
  const hash = createHash("sha256").update(content).digest("hex");
  return `${opts.actor.orgId}:${opts.actor.userId ?? "anon"}:${opts.feature}:${hash}`;
}
