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
import { runWithAiRequestAbort } from "./ai-request-abort";

export const AI_REQUEST_DEADLINE_MS = 120_000;

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
    const req = http.getRequest<CloseableRequest>();
    const res = http.getResponse<EndableResponse>();
    if (typeof res.on !== "function") return next.handle();

    const handle = createStreamAbortSignal(req, res, AI_REQUEST_DEADLINE_MS);

    return from(
      runWithAiRequestAbort(handle.signal, () =>
        lastValueFrom(next.handle(), { defaultValue: undefined }),
      ).finally(() => handle.dispose()),
    );
  }
}
