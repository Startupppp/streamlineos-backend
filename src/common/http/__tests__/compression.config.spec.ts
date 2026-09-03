import { constants as zlibConstants } from "node:zlib";
import type { Request, Response } from "express";
import {
  ALREADY_COMPRESSED,
  BROTLI_QUALITY,
  COMPRESSION_THRESHOLD_BYTES,
  NO_COMPRESSION_HEADER,
  httpCompressionOptions,
  isAlreadyCompressed,
  normalizeContentType,
  shouldCompress,
} from "../compression.config";

/**
 * PRD-C089, asserted on the filter rather than on the app booting.
 *
 * `check:compression` passes on the literal string `compression()` appearing in
 * `main.ts` — it inspects no threshold, no filter and no exclusion, so every property
 * the criterion names could regress with the gate green. These are the assertions the
 * gate cannot make.
 */

function res(headers: Record<string, string>): Response {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    getHeader: (name: string): string | undefined => lower.get(name.toLowerCase()),
  } as unknown as Response;
}

const anyRequest = {} as Request;

describe("HTTP response compression", () => {
  describe("the explicit opt-out", () => {
    it("refuses a response a handler marked, whatever its content type", () => {
      expect(
        shouldCompress(
          anyRequest,
          res({ [NO_COMPRESSION_HEADER]: "1", "content-type": "application/json" }),
        ),
      ).toBe(false);
    });

    it("honours Cache-Control: no-transform", () => {
      expect(
        shouldCompress(
          anyRequest,
          res({ "cache-control": "private, no-transform", "content-type": "application/json" }),
        ),
      ).toBe(false);
    });

    it("does not mistake a different no- directive for no-transform", () => {
      expect(
        shouldCompress(
          anyRequest,
          res({ "cache-control": "no-store", "content-type": "application/json" }),
        ),
      ).toBe(true);
    });
  });

  it("never re-encodes a body that already carries a Content-Encoding", () => {
    expect(
      shouldCompress(
        anyRequest,
        res({ "content-encoding": "gzip", "content-type": "application/json" }),
      ),
    ).toBe(false);
  });

  describe("already-compressed content is excluded", () => {
    it.each([
      "image/png",
      "image/jpeg",
      "video/mp4",
      "audio/mpeg",
      "application/zip",
      "application/gzip",
      "font/woff2",
    ])("%s", (type) => {
      expect(shouldCompress(anyRequest, res({ "content-type": type }))).toBe(false);
    });

    it("excludes application/pdf — the one the compressible database gets wrong for us", () => {
      // Every payslip, offer letter, Form 16 and quote document this API returns was
      // being gzipped over its own already-Flate-compressed object streams.
      expect(isAlreadyCompressed("application/pdf")).toBe(true);
      expect(
        shouldCompress(anyRequest, res({ "content-type": "application/pdf" })),
      ).toBe(false);
    });

    it("still compresses SVG, which is XML despite the image/ prefix", () => {
      expect(shouldCompress(anyRequest, res({ "content-type": "image/svg+xml" }))).toBe(true);
    });

    it("matches through charset parameters and casing", () => {
      expect(isAlreadyCompressed("APPLICATION/PDF; charset=binary")).toBe(true);
      expect(normalizeContentType("Application/JSON; charset=utf-8")).toBe("application/json");
    });

    it("does not exclude a type merely because a prefix appears mid-string", () => {
      expect(isAlreadyCompressed("application/vnd.my-image/png")).toBe(false);
    });
  });

  describe("what stays compressible", () => {
    it.each([
      "application/json",
      "text/html",
      "text/csv",
      "text/event-stream",
      "application/vnd.openapi+json",
    ])("%s", (type) => {
      expect(shouldCompress(anyRequest, res({ "content-type": type }))).toBe(true);
    });

    it("compresses a response with no content type rather than refusing it", () => {
      expect(shouldCompress(anyRequest, res({}))).toBe(true);
    });
  });

  describe("the declared options", () => {
    it("states a minimum size rather than inheriting one", () => {
      expect(httpCompressionOptions().threshold).toBe(COMPRESSION_THRESHOLD_BYTES);
      expect(COMPRESSION_THRESHOLD_BYTES).toBe(1024);
    });

    it("sets brotli quality under the real BROTLI_PARAM_QUALITY key", () => {
      // The key is 1, not 11. 11 is the maximum quality VALUE; using it as the key
      // would set BROTLI_PARAM_MODE and leave quality at the default with no error.
      const params = httpCompressionOptions().brotli.params ?? {};
      expect(params[zlibConstants.BROTLI_PARAM_QUALITY]).toBe(BROTLI_QUALITY);
      expect(zlibConstants.BROTLI_PARAM_QUALITY).toBe(1);
    });

    it("installs this module's filter, not the library default", () => {
      expect(httpCompressionOptions().filter).toBe(shouldCompress);
    });

    it("declares the exclusion list non-empty, so an emptied list fails here", () => {
      expect(ALREADY_COMPRESSED.length).toBeGreaterThanOrEqual(10);
    });
  });
});
