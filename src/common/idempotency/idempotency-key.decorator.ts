import { BadRequestException, createParamDecorator, type ExecutionContext } from "@nestjs/common";

/**
 * A3. The `Idempotency-Key` header, as a required parameter.
 *
 * Twenty inventory handlers carried a hand-copied `if (!key) throw` line, and
 * the copies had drifted into three different messages. Worse, the check being
 * separate from the value made a whole class of bug easy and invisible: several
 * handlers demanded the header, threw without it, and then called the service
 * without passing it — so the client was made to supply a key that changed
 * nothing, and a retried reserve created a second ACTIVE reservation.
 *
 * As a parameter, an unused key is a lint error rather than a silent no-op.
 */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const raw = req.headers["idempotency-key"];
    const key = typeof raw === "string" ? raw.trim() : "";
    if (!key) {
      throw new BadRequestException(
        "An Idempotency-Key header is required for this operation",
      );
    }
    if (key.length > 255) {
      throw new BadRequestException(
        "Idempotency-Key must be at most 255 characters",
      );
    }
    return key;
  },
);
