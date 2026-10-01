import type { NextFunction, Request, Response } from "express";
import { FeedbucketCorsMiddleware } from "../feedbucket-cors.middleware";
import type { Db } from "../../../db/drizzle.module";

/**
 * The widget's first call is `GET :publicKey/config`, and the allowed-methods
 * header had only ever listed POST and OPTIONS. Any browser that preflights that
 * read — one sent with a non-simple header, or any future one that does — is
 * told GET is not allowed and drops it, and the widget then draws with its
 * defaults and no AI assist, silently.
 */
function middleware(allowedDomains: string[] | null): FeedbucketCorsMiddleware {
  const db = {
    query: {
      feedbucketWidgets: {
        findFirst: () =>
          Promise.resolve(allowedDomains === null ? undefined : { allowedDomains }),
      },
    },
  } as unknown as Db;
  return new FeedbucketCorsMiddleware(db);
}

function reqRes(method: string, origin: string | undefined) {
  const headers: Record<string, string> = {};
  const res = {
    setHeader: (name: string, value: string) => {
      headers[name] = value;
    },
    status: () => res,
    end: () => undefined,
  } as unknown as Response;
  const req = {
    method,
    url: "/public/feedbucket/pk_live_abc/config",
    headers: origin === undefined ? {} : { origin },
  } as unknown as Request;
  return { req, res, headers };
}

describe("FeedbucketCorsMiddleware", () => {
  const next: NextFunction = () => undefined;

  it("allows GET, so the widget's config read survives a preflight", async () => {
    const { req, res, headers } = reqRes("GET", "https://www.streamlineos.in");

    await middleware([]).use(req, res, next);

    expect(headers["Access-Control-Allow-Methods"]).toContain("GET");
    expect(headers["Access-Control-Allow-Methods"]).toContain("POST");
    expect(headers["Access-Control-Allow-Origin"]).toBe(
      "https://www.streamlineos.in",
    );
  });

  it("sends no allow headers for an origin outside the widget's domains", async () => {
    const { req, res, headers } = reqRes("GET", "https://evil.example");

    await middleware(["www.streamlineos.in"]).use(req, res, next);

    expect(headers["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headers["Access-Control-Allow-Methods"]).toBeUndefined();
  });
});
