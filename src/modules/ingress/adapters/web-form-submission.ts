import { z } from "zod";
import { signatureMatches, signPayload } from "./mailbox-push";

/**
 * Accepting a web-form submission, safely.
 *
 * This is the least authenticated input in the system. A mailbox delivers what a
 * provider we authorised against says arrived; a form delivers whatever anybody
 * with the URL typed into a box, and the fields, their names and their contents
 * are all attacker-authored. Two rules follow, and both are about what the
 * submission is NOT allowed to do.
 *
 * It may not name its organisation. The form is identified out of band — a key
 * in the path, whose registration row carries the tenant and the secret — and
 * the tenant comes from that row, never from the request. `.strict()` below is
 * what makes that a compile-and-runtime fact rather than a convention: a body
 * carrying `organizationId` is rejected outright rather than quietly ignored,
 * because "ignored" is one careless destructure away from "used".
 *
 * And it may not be believed before it is verified. The signature is checked
 * over the raw bytes first, and everything after that point runs on a payload a
 * shared secret vouched for. This is the same rule `mailbox-push.ts` states for
 * push notifications, and it reuses that file's comparison rather than growing a
 * second one — including its fix, which is the whole reason to reuse it.
 */

/**
 * How many fields one submission may carry.
 *
 * A form with more than a hundred boxes on it is not a form, and the cap is what
 * stops a signed-but-hostile provider payload from becoming an unbounded loop
 * and an unbounded body.
 */
const MAX_FIELDS = 100;

/** One field's value. Long enough for a real message, short of an essay. */
const MAX_VALUE_CHARS = 5_000;

/** Options in a multi-select. Checkbox groups are real; a thousand of them are not. */
const MAX_OPTIONS = 50;

const fieldValueSchema = z.union([
  z.string().max(MAX_VALUE_CHARS),
  z.number(),
  z.boolean(),
  z.null(),
  /**
   * A multi-select arrives as a list on every form provider worth naming.
   *
   * Accepted here rather than left to the transport to flatten, because a
   * transport that joins values is a transport that edits content — and the
   * whole point of this seam is that the adapter is the only place content is
   * shaped.
   */
  z.array(z.string().max(500)).max(MAX_OPTIONS),
]);

export const webFormFieldSchema = z
  .object({
    /**
     * What the form calls this box.
     *
     * The label a person saw, where the provider offers one — it is what the
     * field means, and it is also what `mapColumn` reads to decide whether a
     * value is an identity. A provider that only has opaque ids should send
     * those; an unrecognisable name costs a match, not a submission.
     */
    name: z.string().trim().min(1).max(200),
    value: fieldValueSchema,
  })
  .strict();

/**
 * The envelope a form provider posts.
 *
 * Deliberately tiny. Everything that varies between providers is a field inside
 * `fields`; everything here is something the provider itself knows and the
 * submitter does not get to say.
 */
export const webFormSubmissionSchema = z
  .object({
    /**
     * The provider's own identifier for this submission, where it mints one.
     *
     * Half of the deduplication key. It must be the *provider's*, never
     * something the submitting browser chose: an id under the submitter's
     * control lets one submission suppress another's by claiming its key. Absent
     * is allowed and handled by deriving a content hash — see the normaliser —
     * because plenty of form endpoints have nothing to offer here.
     */
    submissionId: z.string().trim().min(1).max(200).nullish(),
    /** When the provider says it was submitted. Bounded on the way in — see the normaliser. */
    submittedAt: z.string().trim().max(64).nullish(),
    fields: z.array(webFormFieldSchema).min(1).max(MAX_FIELDS),
  })
  .strict();

export type WebFormSubmission = z.infer<typeof webFormSubmissionSchema>;
export type WebFormField = z.infer<typeof webFormFieldSchema>;

/**
 * What a form registration has to carry for any of this to work.
 *
 * Stated as a type rather than a table because the table does not exist yet, and
 * writing the lookup against a schema that has not been agreed would be worse
 * than saying so. The three properties are not negotiable: the tenant, so the
 * body never names one; the secret, so the endpoint is not open; and the key,
 * which becomes the provider label and therefore the deduplication namespace.
 */
interface WebFormRegistration {
  readonly formKey: string;
  readonly organizationId: string;
  /** What the form is called, for the activity's subject. */
  readonly formName: string | null;
  /** The shared secret the provider signs its payloads with. */
  readonly signingSecret: string;
  readonly enabled: boolean;
}

export type WebFormVerdict =
  | { readonly ok: true; readonly submission: WebFormSubmission }
  | {
      readonly ok: false;
      readonly reason: "bad-signature" | "malformed";
      /**
       * Which fields were wrong, for `malformed` only.
       *
       * Safe to return, and only because the signature is checked first:
       * anything that reaches the parse has been vouched for by the tenant's own
       * secret, so the detail goes to the integrator debugging their payload
       * rather than to a stranger probing the endpoint. A `bad-signature` says
       * nothing at all, for the same reason `readPush` says nothing.
       */
      readonly issues?: readonly string[];
    };

/**
 * The submission, or why it is being ignored.
 *
 * `rawBody` and `parsed` are both taken because they must be the same bytes: the
 * signature covers what the provider sent, and re-serialising a parsed object to
 * check it against a signature is how a key ordering difference becomes an
 * intermittent authentication failure.
 */
export function readWebFormSubmission(
  rawBody: string,
  signature: string | undefined,
  secret: string,
  parsed: unknown,
): WebFormVerdict {
  if (!signatureMatches(signPayload(secret, rawBody), signature))
    return { ok: false, reason: "bad-signature" };

  const result = webFormSubmissionSchema.safeParse(parsed);
  if (!result.success)
    return {
      ok: false,
      reason: "malformed",
      issues: result.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message,
      ),
    };

  return { ok: true, submission: result.data };
}
