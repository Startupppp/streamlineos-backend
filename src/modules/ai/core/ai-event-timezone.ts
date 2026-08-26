/**
 * The zone an AI-created calendar event is recorded in.
 *
 * `createEvent` requires an IANA zone, which is the point of c16-02 — an event
 * without one is a different instant in two offices. These tool call sites have
 * no user zone in scope: they run from a chat or comms context that carries an
 * org and an actor id, not a locale.
 *
 * UTC is therefore the honest answer rather than a guess dressed as one. It is
 * stated here once, so the assumption is visible and replaceable in a single
 * place the day an actor's zone becomes available.
 */
export const AI_EVENT_TIMEZONE = "UTC";
