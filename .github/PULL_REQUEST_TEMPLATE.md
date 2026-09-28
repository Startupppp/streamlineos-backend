## What changed

<!-- One paragraph. Link the ticket or spec box this closes. -->

## Verification

<!-- The exact command run and its result. A test file existing is not a test run.
     Journalled is not applied, applied is not deployed, deployed is not workflow-verified. -->

## Checks

- [ ] No open question in the frontend repo's `docs/build-module/99-open-questions.md` was silently resolved by this PR. If this change decides permissions, tenancy, billing, retention or external visibility for a question listed there, the question is answered in that file in the same PR.
- [ ] Behaviour this PR advertises in product copy, a catalog label or an API contract is behaviour this PR implements.
- [ ] Every acceptance box ticked here carries the file, line, command and result that earned it.
- [ ] A removed enum value, trigger event or catalog entry is removed on both sides of the contract in this PR. A value dropped from the backend while a client still offers it is a 400 for live users, not a dead branch.
- [ ] Any migration carries its rollback at `migrations/rollback/NNNN_name.down.sql`, references `build`-schema tables by their qualified name, and contains no comments.
