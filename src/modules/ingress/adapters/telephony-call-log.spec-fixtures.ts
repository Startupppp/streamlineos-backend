import type { TelephonyCallForIngress } from "./telephony-to-inbound-event";

/**
 * A carrier's call log, as the payload rather than as a type.
 *
 * Typed `unknown` on purpose. If these were typed against this module's own Zod
 * schema, a rename on either side would move both together and the spec would go
 * on passing while the real payload stopped parsing — which makes the schema
 * assert itself. The fixture is the contract precisely because it is not checked
 * against the thing it is testing.
 *
 * Snake-cased keys, seconds as strings and an RFC 2822 start time are all how a
 * carrier's REST API actually answers, and each of the three has its own way of
 * going wrong that the specs cover.
 */

/** The first page: one of every case the adapter has an answer for. */
export const CALL_LOG_PAGE_ONE: unknown = {
  calls: [
    {
      sid: "CA0000000000000000000000000000001",
      direction: "inbound",
      from: "+1 (415) 555-1212",
      to: "+14155559000",
      caller_name: "Priya Raman",
      start_time: "Tue, 25 Aug 2026 10:00:00 +0000",
      end_time: "Tue, 25 Aug 2026 10:04:12 +0000",
      duration: "252",
      status: "completed",
      price: "-0.017",
      subresource_uris: {
        recordings:
          "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls/CA0000000000000000000000000000001/Recordings.json",
      },
    },
    {
      sid: "CA0000000000000000000000000000002",
      direction: "inbound",
      from: "+14155551313",
      to: "+14155559000",
      caller_name: null,
      start_time: "Tue, 25 Aug 2026 09:30:00 +0000",
      duration: "0",
      status: "no-answer",
      subresource_uris: { recordings: null },
    },
    {
      sid: "CA0000000000000000000000000000003",
      direction: "outbound-api",
      from: "+14155559000",
      to: "+14155551414",
      start_time: "Tue, 25 Aug 2026 09:00:00 +0000",
      duration: "94",
      status: "completed",
    },
    {
      sid: "CA0000000000000000000000000000004",
      direction: "",
      from: "+14155551515",
      to: "+14155559000",
      start_time: "Tue, 25 Aug 2026 08:45:00 +0000",
      duration: "31",
      status: "completed",
    },
    {
      sid: "CA0000000000000000000000000000005",
      direction: "inbound",
      from: "+14155551616",
      to: "+14155559000",
      start_time: null,
      duration: "12",
      status: "completed",
    },
    {
      sid: "CA0000000000000000000000000000006",
      direction: "inbound",
      from: null,
      to: "+14155559000",
      start_time: "Tue, 25 Aug 2026 08:15:00 +0000",
      duration: "",
      status: "completed",
    },
  ],
  next_page_uri:
    "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json?Page=1&PageToken=PAxyz",
  page: 0,
  uri: "/2010-04-01/Accounts/AC00000000000000000000000000000000/Calls.json",
};

/** The second page, older, and the last one. */
export const CALL_LOG_PAGE_TWO: unknown = {
  calls: [
    {
      sid: "CA0000000000000000000000000000007",
      direction: "inbound",
      from: "+14155551717",
      to: "+14155559000",
      start_time: "Mon, 24 Aug 2026 16:00:00 +0000",
      duration: "88",
      status: "completed",
    },
  ],
  next_page_uri: null,
  page: 1,
};

/** What a wrong path or a wrong account gets back instead of a call log. */
export const CALL_LOG_ERROR_PAYLOAD: unknown = {
  code: 20404,
  message: "The requested resource was not found",
  more_info: "https://www.twilio.com/docs/errors/20404",
  status: 404,
};

/**
 * A single call, already normalised, for specs about the seam adapter itself.
 *
 * Kept beside the raw pages so the two never disagree about what a call is:
 * every field here is one `telephony-call-log` produces from `CALL_LOG_PAGE_ONE`.
 */
export const NORMALISED_INBOUND_CALL: TelephonyCallForIngress = {
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
};
