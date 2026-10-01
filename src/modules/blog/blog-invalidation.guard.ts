import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { BlogInvalidationService } from "./blog-invalidation.service";

/**
 * Checks the blog admin's HMAC before anything parses or validates the body. Guards run ahead of
 * pipes, so an unsigned caller gets a flat 401 instead of field-level validation detail about an
 * endpoint it is not allowed to reach.
 */
@Injectable()
export class BlogInvalidationSignatureGuard implements CanActivate {
  constructor(private readonly invalidation: BlogInvalidationService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<RawBodyRequest<Request>>();
    this.invalidation.verify(
      {
        eventId: header(req, "x-blog-event-id"),
        timestamp: header(req, "x-blog-timestamp"),
        signature: header(req, "x-blog-signature"),
      },
      req.rawBody?.toString("utf8") ?? "",
    );
    return true;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
