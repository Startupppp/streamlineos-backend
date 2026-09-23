# Email delivery — configuration and triage

Written for QA audit v2 / H-03 ("no invite email after create and resend").

## What has to be set

| Variable | Required | Notes |
|---|---|---|
| `ZEPTOMAIL_TOKEN` + `ZEPTOMAIL_API_URL` | one provider required | India-region ZeptoMail. `ZEPTOMAIL_TOKEN` is rejected under 40 chars. |
| `RESEND_API_KEY` | one provider required | Used as the other provider. |
| `EMAIL_PROVIDER` | optional | `zeptomail` or `resend`. Only a *preference* — `selectProvider` falls back to whichever is configured. |
| `NOREPLY_EMAIL` or `EMAIL_FROM_ADDRESS` | **yes** | `getFromEmail()` throws if both are missing or malformed, and every send fails. |
| `EMAIL_FROM_NAME` | optional | Display name on the From header. |
| `APP_URL` or `EMAIL_APP_URL` | **yes** | Base for `${appUrl()}/invitation/<token>`. `appUrl()` throws if unset, so invite links and the join-link route fail loudly rather than emitting a broken URL. |

With no provider configured, `selectProvider` returns `"none"`. `EmailOutboxService`
then marks the row `FAILED` with `lastError: "No email provider configured"` and
throws — the warning is logged as `EMAIL_OUTBOX: no provider configured`.

## Why an invitation can exist with no email sent

`InvitationCreateService.deliverInvitation` runs the send through
`registerAfterCommit`, and a failure is swallowed into
`recordDeliveryFailure` — which writes an `invitation_events` row with
`event: "DELIVERY_FAILED"` and logs. **The invitation is still created.** That is
deliberate (an invitation must not be lost because a provider blipped), and it is
why "invite created, no mail" is the expected shape of a delivery failure rather
than a 500.

## Triage order

1. `select event, created_at from invitation_events where invitation_id = '<id>' order by created_at;`
   A `DELIVERY_FAILED` row means the send was attempted and refused — the reason is
   in the application log for that request's `x-correlation-id`.
2. No `DELIVERY_FAILED` row and no `SENT` outbox row ⇒ the send never ran. Check
   that the process has a provider and a From address.
3. `select status, attempts, last_error from email_outbox where to_email = '<email>' order by created_at desc limit 5;`
4. Check the suppression list — `EmailSuppressionService` is a hard choke point and
   a suppressed address is silently not sent to.
5. **Disposable mailboxes.** Guerrilla Mail and Temp Mail are on most ESPs' blocked
   or high-risk lists, and ZeptoMail in particular refuses many of them outright.
   A failure that reproduces *only* on a disposable address is a deliverability
   policy, not a bug in this repo — retest with a real mailbox before filing.
6. Domain authentication: the From domain needs SPF and DKIM published for the
   active provider, and ZeptoMail additionally requires the domain be verified in
   its console. None of this is visible from the application.

## Getting a working join link without a mailbox

`POST /users/invitations/:invitationId/join-link` (permission
`settings:organization:manage`, rate limit `invite:reissue-link`) reissues the
invitation and returns `{ joinUrl, email, expiresAt }` **once**.

It is the same rotation the resend path performs: a fresh `randomBytes(32)` token,
only its hash stored, expiry extended 7 days, and an audit entry
(`user.invitation.link-reissued`). It sends no email. Any link already sent stops
working, which is the point — there is never more than one live token.

The token is returned by this route and nowhere else. It is not on any read route,
and the route is deliberately **not** `@Idempotent`, because an idempotent replay
would persist the returned token in the replay store.

In the admin UI it is the link button on each pending invitation row in
Settings → People → Invitations.
