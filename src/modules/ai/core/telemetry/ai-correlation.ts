import { randomUUID } from "node:crypto";
import { getObservabilityContext } from "../../../../common/observability";

/**
 * The join key for one AI call.
 *
 * Taken from the ambient request when there is one, so the call, its
 * `ai_usage_logs` row, its audit entry and the request that caused it all carry
 * the same id. Minting is the cron/worker case — genuinely no ambient context —
 * and is reached deliberately rather than by defaulting to it, which is how
 * every gateway call became an orphan trace before.
 *
 * The edge already caps a caller-supplied id at 64 characters, the width of
 * `ai_usage_logs.correlation_id`, so an ambient id always survives the write.
 */
export function resolveAiCorrelationId(): string {
  return getObservabilityContext()?.correlationId ?? randomUUID();
}
