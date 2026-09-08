import type { TelephonySkipReason } from "./telephony-to-inbound-event";

export type { TelephonySkipReason };

export type SkipTally = Record<TelephonySkipReason, number>;

export const NO_SKIPS: SkipTally = {
  "no-identifier": 0,
  "no-timestamp": 0,
  "direction-unknown": 0,
  "no-counterparty": 0,
  "outbound-unattributable": 0,
};

export type TelephonySweepRefusal =
  | "disconnected"
  | "needs-reauth"
  | "not-telephony"
  | "no-account-reference"
  | "provider-error";

export type TelephonySweepResult =
  | { readonly swept: false; readonly reason: TelephonySweepRefusal; readonly note: string }
  | {
      readonly swept: true;
      readonly read: number;
      readonly delivered: number;
      readonly skipped: SkipTally;
      readonly truncated: boolean;
      readonly note: string | null;
    };

export function sweepNote(
  read: number,
  delivered: number,
  skipped: SkipTally,
  truncated: boolean,
): string | null {
  const notes: string[] = [];

  if (truncated)
    notes.push(
      `Read ${read} calls and there are more in the window. Nothing has been skipped, but a backlog this size will not drain on its own.`,
    );

  if (skipped["outbound-unattributable"] > 0)
    notes.push(
      `${skipped["outbound-unattributable"]} of ${read} calls were outbound and are not filed. The inbound event has no direction, and the party is resolved from whoever called — so an outbound call would be filed against the number that dialled it, which is ours.`,
    );

  if (skipped["direction-unknown"] > 0)
    notes.push(
      `${skipped["direction-unknown"]} of ${read} calls did not state a direction and were left alone rather than guessed at.`,
    );

  const unusable =
    skipped["no-identifier"] + skipped["no-timestamp"] + skipped["no-counterparty"];
  if (unusable > 0)
    notes.push(
      `${unusable} of ${read} calls were missing an identifier, a start time or the other party's number.`,
    );

  if (read > 0 && delivered === 0 && notes.length === 0)
    notes.push(`Read ${read} calls and filed none of them.`);

  return notes.length > 0 ? notes.join(" ") : null;
}
