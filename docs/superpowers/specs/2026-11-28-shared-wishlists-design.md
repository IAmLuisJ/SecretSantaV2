# Shared wish lists

## Intent

A person or Little One participating in multiple exchanges should maintain one set of shared wishes. Purchasing a shared wish in one exchange updates its availability in every exchange where it is visible. Individual wishes can remain exclusive to one exchange.

## Proposed behavior

- A wish has one identity and either an account-wide/child-wide scope or one group scope. Shared wishes are never copied between groups.
- New wishes default to shared, with a clearly labeled **Only this exchange** alternative. Existing wishes remain specific to their original group. A wish's manager can change its scope later without replacing its photo or purchase state.
- Adults see their own shared wishes in every exchange they belong to. Assigned givers see shared wishes plus wishes for that exchange only, after the latest draw is released. Purchase state is visible to givers and is omitted from the recipient's own view and response data.
- Little Ones have stable identities with explicit links to participating exchanges. The account that adds a Little One can reuse that child in another exchange through **Use an existing Little One**. Matching names never links children automatically.
- A Little One's manager controls shared wishes and linking to other exchanges. Group members can continue contributing exchange-specific wishes and tracking purchases. Historical child records do not record who added them: preserve them without assigning an inferred guardian, and offer existing group members an explicit **Manage this Little One's shared list** action before reusing the child elsewhere. Newly added children are managed by their creator.
- Shared wishes and child identities survive deletion of their original exchange. Group-specific wishes disappear with their group. Account merging preserves shared wishes and managed Little Ones.
- Photos follow the same scope and viewing permissions as their wishes. Wishlist reminders consider shared wishes when deciding whether a list is empty.

## Approaches

1. **Canonical wishes with an optional exchange scope (recommended).** Store each wish once, owned by an account or a child, and use a nullable group reference for shared versus exchange-specific visibility. Link children explicitly to exchanges. This provides one authoritative purchase state and survives group deletion.
2. **Copy wishes into each exchange and synchronize purchases.** Requires duplicate detection and synchronization, complicates deletion and photos, and risks diverging availability. Rejected because it works against a single shared list.
3. **Keep wishes attached to their original membership and mark some shared.** Requires fewer initial schema changes but makes shared data depend on an unrelated group's continued existence. Rejected because deleting an exchange could delete wishes used elsewhere.

The user approved shared wishes by default, exchange-specific overrides, preservation of existing scopes, explicit Little One reuse, and hidden adult purchase flags on 2026-11-28. The canonical storage and historical-child management flow are implementation decisions.

## Data and migration

Add an ordered migration that preserves IDs, metadata, photos, purchase flags, and creation times. Rebuild gift ownership around accounts and stable children; retain the original group on all migrated wishes. Preserve each child's original exchange link; allow a historical child's initially empty manager field to be claimed atomically by a current group member. Keep foreign keys, relevant query indexes, and deferred photo-cleanup behavior intact. Remove the schema constraint prohibiting adult purchase flags, but mask those flags in adult owners' server responses.

## Interface

Keep the existing dashboard and wish cards. Add a **Show this wish in** field with **All my exchanges** / **All of this Little One's exchanges** and **Only this exchange** choices. Add a scope label and an expandable scope editor to manageable wishes. Add purchase controls to the assigned adult recipient's wishes. Offer a picker for managed Little Ones not yet linked to the current exchange.

## Constraints and exclusions

Use the existing React Router, Cloudflare D1/R2, server actions, progressive forms, and visual conventions. Preserve codename privacy and the membership-change check. Do not infer links from names, expose other group identities, add external services, or deploy as part of this change. Existing duplicate child records will remain separate unless the user explicitly requests consolidation; adding a stable existing child to another exchange is the reuse path in this change. Live availability may refresh when a dashboard regains focus; every server read and mutation uses current canonical state.

Both reminder checks (queueing and delivery) must account for shared wishes. The guarded account-merge transaction must transfer account-owned wishes and managed children before removing the other account. Little Ones retain the existing group-visible purchase status, including visibility to their managers; only adult wish owners receive masked purchase flags.

## Validation

Verify migration of populated databases and application to fresh D1; cross-exchange adult and child purchases; group-specific isolation; released-draw and photo permissions; recipient purchase-state secrecy; scope changes; account merging; group deletion; reminder eligibility; and the complete browser flow. Run TypeScript, the unit/integration suite, both mobile browser projects, and the Worker build.
