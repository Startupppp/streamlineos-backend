import {
  callLogPath,
  parseCallPage,
  TelephonyCallLogShapeError,
  TELEPHONY_PROVIDER,
} from "./telephony-call-log";
import {
  CALL_LOG_ERROR_PAYLOAD,
  CALL_LOG_PAGE_ONE,
  CALL_LOG_PAGE_TWO,
} from "./telephony-call-log.spec-fixtures";
import { telephonyCallToInboundEvent } from "./telephony-to-inbound-event";

/**
 * The fixture is the contract, so this file reads it as a carrier would send it.
 *
 * Nothing here mocks a provider SDK, and there is none in this repo to mock. What
 * is under test is the translation of a payload nobody in this codebase has ever
 * received — which is exactly why the refusal cases matter more than the happy
 * one: an unverifiable request that comes back wrong has to stop the sweep, not
 * quietly produce nothing.
 */

describe("parseCallPage", () => {
  it("reads a carrier's page into the fields the seam adapter needs", () => {
    const page = parseCallPage(CALL_LOG_PAGE_ONE);

    expect(page.calls).toHaveLength(6);
    expect(page.calls[0]).toEqual({
      id: "CA0000000000000000000000000000001",
      direction: "inbound",
      fromNumber: "+1 (415) 555-1212",
      toNumber: "+14155559000",
      startedAt: "Tue, 25 Aug 2026 10:00:00 +0000",
      durationSeconds: 252,
      recordingReference:
        "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls/CA0000000000000000000000000000001/Recordings.json",
      transcript: null,
      callerName: "Priya Raman",
    });
  });

  /**
   * The whole reason this reads through the HTTP proxy rather than a named
   * Composio tool. A wrong path is a 404 body; a permissive schema would read
   * that as "no calls", advance nothing, report a healthy sweep, and leave
   * somebody believing their calls were in the CRM.
   */
  it("refuses a payload that is not a page of calls, rather than reading it as none", () => {
    expect(() => parseCallPage(CALL_LOG_ERROR_PAYLOAD)).toThrow(TelephonyCallLogShapeError);
    expect(() => parseCallPage(null)).toThrow(TelephonyCallLogShapeError);
    expect(() => parseCallPage([])).toThrow(TelephonyCallLogShapeError);
    expect(() => parseCallPage({ calls: "none" })).toThrow(TelephonyCallLogShapeError);
  });

  /** A call log is full of customers' phone numbers, so the diagnostic names keys only. */
  it("says what it got back without putting the payload in a log line", () => {
    let message = "";
    try {
      parseCallPage(CALL_LOG_ERROR_PAYLOAD);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("more_info");
    expect(message).not.toContain("https://www.twilio.com/docs/errors/20404");
  });

  it("follows the provider's own next-page uri and stops when there is none", () => {
    expect(parseCallPage(CALL_LOG_PAGE_ONE).nextPath).toBe(
      "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json?Page=1&PageToken=PAxyz",
    );
    expect(parseCallPage(CALL_LOG_PAGE_TWO).nextPath).toBeNull();
  });

  describe("the fields carriers get creative about", () => {
    const page = parseCallPage(CALL_LOG_PAGE_ONE);

    it("narrows every outbound spelling to one, and refuses the rest", () => {
      expect(page.calls[2]?.direction).toBe("outbound");
      expect(page.calls[3]?.direction).toBeNull();
    });

    it("reads seconds sent as a string, and an empty one as unknown rather than zero", () => {
      expect(page.calls[1]?.durationSeconds).toBe(0);
      expect(page.calls[5]?.durationSeconds).toBeNull();
    });

    it("locates a recording where there is one and claims none where there is not", () => {
      expect(page.calls[1]?.recordingReference).toBeNull();
      expect(page.calls[2]?.recordingReference).toBeNull();
    });

    /**
     * A transcript is a separate resource on every carrier, and fetching one
     * needs a request nothing in this repo can verify. Absent, never invented.
     */
    it("never produces a transcript from a call-log entry", () => {
      expect(page.calls.every((entry) => entry.transcript === null)).toBe(true);
    });
  });
});

describe("callLogPath", () => {
  it("scopes the request to the carrier account the connection names", () => {
    expect(callLogPath("AC00000000000000000000000000000000")).toBe(
      "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json",
    );
  });

  /** The account reference comes off a row somebody's authorisation flow wrote. */
  it("escapes an account reference rather than letting it steer the path", () => {
    expect(callLogPath("../Accounts/AC999")).toBe(
      "/2010-04-01/Accounts/..%2FAccounts%2FAC999/Calls.json",
    );
  });
});

/**
 * The page all the way through to events, which is the only claim that matters.
 *
 * Six calls in, two out — and the four that do not become events each fail for a
 * reason with a name, so a sweep can say which rather than reporting a number.
 */
describe("a carrier page through the seam", () => {
  const results = parseCallPage(CALL_LOG_PAGE_ONE).calls.map((entry) =>
    telephonyCallToInboundEvent(entry, { organizationId: "org-1", provider: TELEPHONY_PROVIDER }),
  );

  it("delivers the inbound calls, including the one that rang out", () => {
    const events = results.flatMap((result) => (result.ok ? [result.event] : []));
    expect(events.map((event) => event.providerMessageId)).toEqual([
      "CA0000000000000000000000000000001",
      "CA0000000000000000000000000000002",
    ]);
  });

  it("refuses the rest, each for a reason it can be asked about", () => {
    const reasons = results.flatMap((result) => (result.ok ? [] : [result.reason]));
    expect(reasons).toEqual([
      "outbound-unattributable",
      "direction-unknown",
      "no-timestamp",
      "no-counterparty",
    ]);
  });

  it("gives none of them a body, because none of them came with a transcript", () => {
    const bodies = results.flatMap((result) => (result.ok ? [result.event.body] : []));
    expect(bodies).toEqual([null, null]);
  });
});
