/**
 * Identifies the running build so a deploy can be implicated in a spike.
 *
 * Read from the environment rather than the package version, because the
 * version rarely changes between deploys and the whole point is to tell one
 * deploy from the next. `APP_RELEASE` is optional: an unset release costs one
 * field on a log line, and refusing to boot without it would be a worse trade.
 *
 * **Read from `process.env` rather than `APP_CONFIG`, on purpose.** The caller
 * that matters is `LogErrorReporter`, which `main.ts` constructs by hand —
 * `setErrorReporter(new LogErrorReporter())` — and which its own comment says
 * runs from the global exception filter and deliberately avoids the machinery
 * that may itself be the thing failing. Taking this value through the injector
 * would mean the release stamp is available only while the container is
 * healthy, which is the opposite of when an error report needs it. That is why
 * this file carries a `no-restricted-syntax` allowlist entry.
 *
 * Set it in CI to the commit sha. (It *is* declared in `env.validation.ts`, as
 * an optional string — an earlier version of this comment said it was not.)
 */
export function currentRelease(): string {
  const release = process.env["APP_RELEASE"];
  return release !== undefined && release.trim() !== "" ? release.trim() : "unknown";
}
