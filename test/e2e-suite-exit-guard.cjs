"use strict";

module.exports = function (results) {
  const execErrors = results.testResults.filter((r) => r.testExecError != null);
  const suiteFailures = results.testResults.filter(
    (r) => r.status === "failed" && r.testResults.length === 0 && r.testExecError == null,
  );

  if (execErrors.length > 0) {
    process.stderr.write(
      `\n[e2e-suite-exit-guard] ${execErrors.length} suite(s) failed to execute:\n`,
    );
    for (const r of execErrors) {
      const msg = r.testExecError?.message ?? "(no message)";
      process.stderr.write(`  EXEC ERROR: ${r.testFilePath}\n    ${msg.split("\n")[0]}\n`);
    }
  }

  if (suiteFailures.length > 0) {
    process.stderr.write(
      `\n[e2e-suite-exit-guard] ${suiteFailures.length} suite(s) failed with no test results:\n`,
    );
    for (const r of suiteFailures) {
      process.stderr.write(`  SUITE FAIL: ${r.testFilePath}\n`);
    }
  }

  const totalFailed =
    results.numFailedTestSuites +
    execErrors.length +
    suiteFailures.length;

  if (totalFailed > 0) {
    process.stderr.write(
      `\n[e2e-suite-exit-guard] Exiting 1 — ${totalFailed} failed suite(s) detected.\n`,
    );
    process.exitCode = 1;
  }

  return results;
};
