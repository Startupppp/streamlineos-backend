import { Inject, Injectable, NestMiddleware } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { DRIZZLE } from "../../db/drizzle.constants";
import type { Db } from "../../db/drizzle.module";
import { feedbucketWidgets } from "../../db/schema";

@Injectable()
export class FeedbucketCorsMiddleware implements NestMiddleware {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers["origin"] as string | undefined;
    if (!origin) return next();

    const url = req.url;
    const match = /\/public\/feedbucket\/([^/?#]+)/.exec(url);
    const publicKey = match?.[1];
    if (!publicKey) return next();

    let originAllowed = false;
    try {
      const widget = await this.db.query.feedbucketWidgets.findFirst({
        where: and(
          eq(feedbucketWidgets.publicKey, publicKey),
          eq(feedbucketWidgets.isActive, true),
          isNull(feedbucketWidgets.deletedAt),
        ),
        columns: { allowedDomains: true },
      });

      if (widget) {
        if (widget.allowedDomains.length === 0) {
          originAllowed = true;
        } else {
          try {
            const hostname = new URL(origin).hostname;
            originAllowed = widget.allowedDomains.includes(hostname);
          } catch {
            originAllowed = false;
          }
        }
      }
    } catch {
      return next();
    }

    if (originAllowed) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    }

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    return next();
  }
}
