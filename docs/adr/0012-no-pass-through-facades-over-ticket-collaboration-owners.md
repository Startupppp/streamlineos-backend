# ADR 0012: no pass-through facades over ticket collaboration owners

**Status:** accepted — extends BE-143; written from the architecture review
(2026-10-01).
**Date:** 2026-10-01.
**Decision:** controllers reach ticket collaboration modules (comments,
checklists, links, relations) directly. A service whose entire body delegates
to one other exported service is deleted; if it is a file's only export, the
file goes with it.

---

## The problem

`projects-ticket-subresources.service.ts` is a 570+ line service that exposes
31 methods. Of those, 22 are pure pass-throughs: the body is a single call to
another module's exported service forwarding identical arguments. Examples:

```ts
createComment(…) { return this.comments.create(…); }
addChecklist(…)  { return this.checklists.add(…); }
addRelation(…)   { return this.relations.add(…); }
```

This facade sits between the three controllers that call it (comments,
associations, checklists) and the four modules that actually own behavior
(comments, checklists, links, relations). It is the shape BE-143 names as a
defect: a function whose entire body is a call to one other exported function
forwarding the same arguments.

The non-pass-through portion of the service (watcher management, label
mapping, ticket-attachment reads, activity logging) mixes unrelated ownership
into the same 570-line file, hiding each real owner behind the facade's
interface.

## The decision

The facade is deleted. Its callers (controllers and other services) reach
collaboration modules directly:

- `CommentsController` → `comments` module service
- `AssociationsController` → `links` and `relations` module services
- `ChecklistsController` → `checklists` module service

Shared authorization context that every collaboration operation needs (e.g.,
asserting the actor can reach the ticket's project) is expressed as a shared
utility function in `core/lib/`, not as a method on the facade. Each
collaboration module imports that utility directly.

The non-pass-through behavior that currently lives in the facade belongs to its
cohesive owner:

- watcher management → the watchers service or the collaboration module that
  triggers it;
- label mapping → the label-mapping module;
- ticket-attachment reads → the attachments module;
- activity logging → the activity module, called from the collaboration
  module after the write.

This decision applies to any future service that would wrap a single collaboration
module with no narrowing, no type transformation, and no hidden module-private
value.

## Consequences

**Ownership is visible at the import level.** A `CommentsController` that
imports from the comments module makes its ownership obvious. The current
indirection hides it.

**BE-143 is the governing rule.** A wrapper earns its keep only by narrowing a
type, binding an argument, adapting a shape, or hiding a module-private value.
The facade earns none of these — every method could be a direct call.

**Tests hit real interfaces.** Specs that tested the facade's pass-through
methods by mocking the facade are vacuous — they test that delegation works,
not that the collaboration module behaves correctly. After deletion, those
specs are rewritten against the collaboration module's own interface.

**Incremental removal.** The facade may be deleted method-by-method if the
owning module needs to absorb shared authorization before the controller calls
it directly. Each removal is independently releasable. A method that is not a
pure pass-through is moved to its cohesive owner before the file is deleted.

## The rule that holds

> A function that only forwards to one other exported function is deleted.
> Controllers reach collaboration owners directly. Shared context is a utility,
> not a facade.
