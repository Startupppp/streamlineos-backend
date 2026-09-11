import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { from, lastValueFrom, type Observable } from "rxjs";
import {
  createStreamAbortSignal,
  type CloseableRequest,
  type EndableResponse,
} from "../../../../common/http/stream-abort";
import { runWithAiRequestScope } from "./ai-request-abort";

export const AI_REQUEST_DEADLINE_MS = 120_000;

/**
 * A caller-supplied header, so it is bounded before it reaches a `varchar(120)`
 * column's key derivation. `IdempotencyInterceptor` caps at 255; this is tighter.
 */
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

interface IdempotentRequest {
  readonly headers?: Record<string, unknown>;
}

function idempotencyKeyOf(req: IdempotentRequest): string | undefined {
  const raw: unknown = req.headers?.["idempotency-key"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > MAX_IDEMPOTENCY_KEY_LENGTH) return undefined;
  return trimmed;
}

/**
 * Arms cancellation for the buffered AI surfaces. Without it the gateway's
 * `signal` option is dead plumbing: nothing on a `@NoTenantTransaction()` route
 * ever supplies one, so a client that hangs up keeps paying for tokens nobody
 * will read until the provider's own timeout expires.
 */
@Injectable()
export class AiRequestAbortInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<CloseableRequest & IdempotentRequest>();
    const res = http.getResponse<EndableResponse>();
    if (typeof res.on !== "function") return next.handle();

    const handle = createStreamAbortSignal(req, res, AI_REQUEST_DEADLINE_MS);

    const idempotencyKey = idempotencyKeyOf(req);

    return from(
      runWithAiRequestScope(
        {
          signal: handle.signal,
          ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
        },
        () => lastValueFrom(next.handle(), { defaultValue: undefined }),
      ).finally(() => handle.dispose()),
    );
  }
}
