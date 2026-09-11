import {
  Inject,
  Injectable,
  StreamableFile,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Readable } from "node:stream";
import type { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { ZodType } from "zod";
import { APP_CONFIG } from "../../config/config.module";
import type { AppConfig } from "../../config/env.validation";
import { logger } from "../logger/logger.service";
import { RESPONSE_SCHEMA } from "./zod-operation-contracts";

/**
 * The half of the contract nothing was checking.
 *
 * THE MEASUREMENT THIS EXISTS FOR. `openapi.json` carries a 2xx *response* content
 * schema on 1 of 3,642 operations, and the browser client reads every one of them
 * through `apiClient.get<T>(...)`, which is a CAST and not a validation. The request
 * half of this API is arbitrated at three layers — `@Validate`, the generated request
 * schema, `check:bounded-contracts`. The response half was arbitrated nowhere: the
 * backend could rename, move or stop sending a field and BOTH repositories would
 * typecheck clean while the screen rendered wrong. That has shipped twice — a
 * permanently empty Favourites list, and huddle tiles that all read "Unknown" with
 * the WebRTC mesh unable to dial.
 *
 * `@ResponseSchema` already existed and already reached `build-openapi-document`, but
 * it was DOCUMENTATION: nothing ever compared a declared shape against the value the
 * handler actually produced, so a schema could be wrong from the day it was written
 * and no test, gate or typecheck would say so. Documentation never compared against
 * the thing it documents is the same defect as no documentation, one step better
 * hidden — it reads as coverage.
 *
 * This interceptor compares them. From here a declared contract is an assertion about
 * the wire, and the response-schema count is a count of routes whose shape is PROVEN
 * rather than merely described.
 *
 * WHY NOT `.parse()` INTO THE RESPONSE. Returning `result.data` would make the
 * contract the projection and would strip anything undeclared — attractive for
 * PRD-C088, and rejected: it would silently change the wire on every contracted route
 * at once, including fields a client reads that the schema author forgot. Detection
 * first; a projection that strips has to be a separate, per-route decision. The value
 * that leaves this interceptor is always the value that entered it.
 *
 * WHERE IT THROWS, AND WHY ONLY THERE. Under `NODE_ENV=test` a violation throws, so
 * every spec, e2e and seeded run that touches a contracted route fails loudly on
 * drift — that is where both shipped defects would have been caught. In development
 * and production it logs at error and passes the payload through unchanged: a
 * contract bug is a bug in the CONTRACT as often as in the service, and 500-ing a live
 * user over a schema typo trades a wrong field for a dead screen. The frontend's own
 * `parseApiResponse` already fails closed at the point of consumption
 * (`frontend/lib/api-envelope.ts`), so the strict half of the pair lives where the
 * reader is; this half exists to stop the drift reaching a deploy at all.
 *
 * NOT VALIDATED, DELIBERATELY:
 *  - `StreamableFile`, `Readable`, `Buffer`, anything with `.pipe` — a download or an
 *    SSE stream has no JSON body to compare, and draining one to look at it would
 *    defeat PRD-C090.
 *  - `undefined` — a 204, or a handler that wrote to `res` itself.
 * Each is skipped silently rather than reported, because none of them is drift.
 */

/**
 * `ResponseTransformInterceptor` (registered in `main.ts`) wraps any handler return
 * that does not already carry a `success` key as `{ success: true, data }`. Whether
 * this interceptor observes the value before or after that wrap depends on global
 * interceptor ordering, and a contract must not depend on it — so a schema is
 * accepted against the value as given OR against `data` inside the envelope, and a
 * schema that itself declares `success` still matches the un-enveloped body first.
 */
/** Narrowed rather than asserted: `check:type-assertions` runs to zero here. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function envelopeInner(value: unknown): { present: false } | { present: true; inner: unknown } {
  if (!isPlainRecord(value)) return { present: false };
  if (value["success"] !== true || !("data" in value)) return { present: false };
  return { present: true, inner: value["data"] };
}

export function isUnvalidatableBody(value: unknown): boolean {
  if (value === undefined) return true;
  if (value instanceof StreamableFile) return true;
  if (value instanceof Readable) return true;
  if (Buffer.isBuffer(value)) return true;
  // Anything duck-typed as a stream: a Nest handler may return a provider's own
  // response object, which pipes but is not a `Readable`.
  return isPlainRecord(value) && typeof value["pipe"] === "function";
}

/**
 * Paths and Zod issue codes only — never the value.
 *
 * A response body is exactly the place a token, an email address or a customer's
 * address lives, and Zod's own `message` quotes the received value for several issue
 * codes. Reporting `path: code` says which field drifted and how without putting the
 * payload into a log line (`check:log-secrets`).
 */
export function violationPaths(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; code: string }>,
): string[] {
  const seen = new Set<string>();
  for (const issue of issues.slice(0, 20)) {
    const path = issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".");
    seen.add(`${path}: ${issue.code}`);
  }
  return [...seen];
}

/** Test is the enforcing environment; everywhere else observes. See the class docblock. */
export function enforcesResponseContracts(nodeEnv: AppConfig["NODE_ENV"]): boolean {
  return nodeEnv === "test";
}

export class ResponseContractViolation extends Error {
  constructor(
    readonly route: string,
    readonly paths: readonly string[],
  ) {
    super(
      `Response contract violated on ${route}: ${paths.join(" · ")}. ` +
        `The handler returned a shape its @ResponseSchema does not describe — either the ` +
        `service changed and the schema did not, or the schema was never true.`,
    );
    this.name = "ResponseContractViolation";
  }
}

/**
 * Pure so the decision is testable without an HTTP request: returns the paths that
 * violate the contract, or `null` when the body satisfies it or cannot be compared.
 */
export function checkResponseAgainstContract(schema: ZodType, value: unknown): string[] | null {
  if (isUnvalidatableBody(value)) return null;

  const direct = schema.safeParse(value);
  if (direct.success) return null;

  const envelope = envelopeInner(value);
  if (!envelope.present) return violationPaths(direct.error.issues);

  const inner = schema.safeParse(envelope.inner);
  if (inner.success) return null;
  // The inner issues, not the outer ones: the outer parse only ever reports that the
  // envelope's own keys are not the schema's, which names no drifted field.
  return violationPaths(inner.error.issues);
}

@Injectable()
export class ResponseContractInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const schema = this.reflector.getAllAndOverride<ZodType | undefined>(RESPONSE_SCHEMA, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!(schema instanceof ZodType)) return next.handle();

    const route = `${context.getClass().name}.${context.getHandler().name}`;

    return next.handle().pipe(
      map((value: unknown) => {
        const paths = checkResponseAgainstContract(schema, value);
        if (paths === null) return value;

        if (enforcesResponseContracts(this.config.NODE_ENV))
          throw new ResponseContractViolation(route, paths);

        logger.error("Response contract violated", { route, paths });
        return value;
      }),
    );
  }
}
