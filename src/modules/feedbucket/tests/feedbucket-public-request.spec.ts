import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { Request } from "express";
import {
  assertOriginAllowed,
  assertScreenshotAcceptable,
  normalizeMultipartBody,
  MAX_SCREENSHOT_BYTES,
  type FeedbucketWidget,
} from "../lib/feedbucket-public-request";

const PNG_MAGIC = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function file(
  over: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: "screenshot",
    originalname: "shot.png",
    encoding: "7bit",
    mimetype: "image/png",
    size: 1024,
    buffer: PNG_MAGIC,
    stream: undefined as never,
    destination: "",
    filename: "",
    path: "",
    ...over,
  } as Express.Multer.File;
}

function widget(allowedDomains: string[]): FeedbucketWidget {
  return { allowedDomains } as unknown as FeedbucketWidget;
}

function req(headers: Record<string, string>): Request {
  return { headers } as unknown as Request;
}

describe("assertScreenshotAcceptable — public upload admission", () => {
  it("accepts a PNG under the cap whose bytes match its declared type", () => {
    expect(() => assertScreenshotAcceptable(file())).not.toThrow();
  });

  it("refuses a screenshot over the 5MB cap", () => {
    expect(() =>
      assertScreenshotAcceptable(file({ size: MAX_SCREENSHOT_BYTES + 1 })),
    ).toThrow(BadRequestException);
    expect(() =>
      assertScreenshotAcceptable(file({ size: MAX_SCREENSHOT_BYTES + 1 })),
    ).toThrow(/under 5MB/);
  });

  it("refuses a MIME type outside the image allowlist", () => {
    expect(() =>
      assertScreenshotAcceptable(
        file({ mimetype: "application/pdf", buffer: PNG_MAGIC }),
      ),
    ).toThrow(/must be an image/);
  });

  it("refuses an allowlisted MIME whose magic bytes disagree (a renamed file)", () => {
    expect(() =>
      assertScreenshotAcceptable(
        file({ mimetype: "image/png", buffer: JPEG_MAGIC }),
      ),
    ).toThrow(/does not match its type/);
  });

  it("refuses an executable payload wearing an image MIME", () => {
    expect(() =>
      assertScreenshotAcceptable(
        file({
          mimetype: "image/jpeg",
          buffer: Buffer.from("#!/bin/sh\nrm -rf /", "utf8"),
        }),
      ),
    ).toThrow(BadRequestException);
  });
});

describe("assertOriginAllowed — widget domain allowlist", () => {
  it("refuses a browser origin that is not on a non-empty allowlist", () => {
    expect(() =>
      assertOriginAllowed(
        widget(["app.example.com"]),
        req({ origin: "https://evil.example.net" }),
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows an origin that is on the allowlist", () => {
    expect(() =>
      assertOriginAllowed(
        widget(["app.example.com"]),
        req({ origin: "https://app.example.com/page" }),
      ),
    ).not.toThrow();
  });

  it("falls back to Referer when Origin is absent", () => {
    expect(() =>
      assertOriginAllowed(
        widget(["app.example.com"]),
        req({ referer: "https://evil.example.net/x" }),
      ),
    ).toThrow(ForbiddenException);
  });

  it("allows anything when the widget declares no allowlist", () => {
    expect(() =>
      assertOriginAllowed(widget([]), req({ origin: "https://anywhere.test" })),
    ).not.toThrow();
  });

  it("allows a request with no resolvable origin (non-browser caller)", () => {
    expect(() =>
      assertOriginAllowed(widget(["app.example.com"]), req({})),
    ).not.toThrow();
  });
});

describe("normalizeMultipartBody", () => {
  it("JSON-parses only the three multipart fields that carry JSON", () => {
    const out = normalizeMultipartBody({
      metadata: '{"a":1}',
      consoleLogs: "[]",
      networkLogs: "[]",
      message: '{"not":"parsed"}',
    });
    expect(out.metadata).toEqual({ a: 1 });
    expect(out.consoleLogs).toEqual([]);
    expect(out.networkLogs).toEqual([]);
    expect(out.message).toBe('{"not":"parsed"}');
  });

  it("passes unparseable JSON through verbatim so Zod reports it", () => {
    expect(normalizeMultipartBody({ metadata: "{oops" }).metadata).toBe(
      "{oops",
    );
  });
});
