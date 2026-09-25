import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

/**
 * Cross-origin access, DECLARED rather than reflected.
 *
 * `enableCors` was called without `allowedHeaders`, so the cors package answered
 * every preflight by echoing back whatever `Access-Control-Request-Headers`
 * named. The effective allowlist was therefore the caller's own list: nothing in
 * the repository stated which custom headers a browser may send, so nothing
 * could review or test it, and removing one from the client would never be
 * noticed here.
 *
 * The list below is the headers the BROWSER sends. `x-client-user-agent`,
 * `x-client-app`, `x-client-ip`, `x-streamlineos-client`, `x-internal-secret`
 * and `x-session-proof` are set by the Next server on its own server-to-server
 * hop (see `src/common/auth/README.md`) and never cross an origin, so they are
 * deliberately absent. Webhook signature headers (`stripe-signature`,
 * `x-razorpay-signature`, `x-hub-signature-256`, …) arrive from providers, not
 * from a browser, and are likewise absent.
 */
export const CORS_ALLOWED_HEADERS = [
  "authorization",
  "content-type",
  "idempotency-key",
  "x-correlation-id",
  "x-request-id",
  "traceparent",
  // HR performance engagement routes read `@Headers("x-action")` from the app.
  "x-action",
] as const;

/**
 * A cross-origin download can only read the headers named here. Without
 * Content-Disposition the browser hands the caller a blob with no filename, and
 * without the pagination headers an export that spans pages looks complete after
 * the first one — which is how a partial asset export read as a finished file
 * (HRMS-E2E-013).
 */
export const CORS_EXPOSED_HEADERS = [
  "x-correlation-id",
  "x-request-id",
  "traceparent",
  "content-disposition",
  "x-has-more",
  "x-next-cursor",
] as const;

export function corsOptions(options: {
  origins: string[];
  isDevelopment: boolean;
}): CorsOptions {
  const { origins, isDevelopment } = options;
  return {
    origin: isDevelopment
      ? (origin, callback): void => {
          callback(null, !origin || origins.includes(origin));
        }
      : origins,
    credentials: true,
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
  };
}
