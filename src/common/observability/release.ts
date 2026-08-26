/**
 * Identifies the running build so a deploy can be implicated in a spike.
 *
 * Read from the environment rather than the package version, because the
 * version rarely changes between deploys and the whole point is to tell one
 * deploy from the next. `APP_RELEASE` is optional and deliberately not in the
 * startup `validationSchema`: an unset release costs one field on a log line,
 * and refusing to boot without it would be a worse trade.
 *
 * Set it in CI to the commit sha.
 */
export function currentRelease(): string {
  const release = process.env["APP_RELEASE"];
  return release !== undefined && release.trim() !== "" ? release.trim() : "unknown";
}
