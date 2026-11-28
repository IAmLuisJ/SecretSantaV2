# Shared Wish Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support canonical shared adult and Little One wishes, synchronized purchases, and exchange-specific overrides.

**Architecture:** Wishes belong to an account or a stable child identity, with a nullable group scope. Children are explicitly linked to groups and managed by an account. Existing data migrates with its original group scope and identifiers intact.

**Tech Stack:** Existing React Router 8 / React 19, TypeScript, Cloudflare D1/R2, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-28-shared-wishlists-design.md`

## Global Constraints

- New wishes default to shared; migrated wishes keep their original scope.
- Adult recipients never receive their own purchase state from the server.
- Preserve membership-change checks, draw release privacy, codename behavior, private photos, and progressive forms.
- Reuse existing dependencies, conventions, and current suitable checkout; do not deploy.
- Preserve existing group-member management of exchange-specific child wishes; only the child manager manages shared wishes and reuse.

## Review Focus

- Deleting the originating group must preserve canonical shared wishes and managed children.
- Scope changes must preserve wish identity, photo, and purchase state, including purchased shared wishes made private.
- Stale forms and guessed item/child IDs must not grant access across groups or before a draw releases.
- Account merges must move shared ownership before deleting the old account.
- Shared wishes must prevent empty-list reminders at queue and delivery time.

---

### Task 1: Canonical storage and server behavior

**Files:** Create `migrations/0011_shared_wishlists.sql`, `tests/shared-wishlists.test.ts`; modify `app/types.ts`, `app/server/gifts.ts`.

**Interfaces:** Use `getDashboard(db, exchange, origin, userId, mailEnabled)` with the authenticated account explicitly bound to a single read snapshot; keep `mutateGifts(env, userId, groupId, form, expectedMemberId)`. Add `GiftItem.scope: "shared" | "exchange"`, `GiftItem.canManage: boolean`, child manager/claim capabilities, and `DashboardData.reusableChildren`. Omit `GiftItem.purchased` from owner responses. New action intents: `link-child`, `claim-child`, and `set-item-scope`; scope form values are `shared` and `exchange`.

- [x] Write migration tests for populated legacy data and behavior tests for adult sharing, scope isolation, masked owner purchases, child reuse, unauthorized access, and surviving group deletion.
- [x] Run `npx vitest run tests/shared-wishlists.test.ts`; confirm failures demonstrate missing schema/behavior.
- [x] Implement migration, typed dashboard data, guarded visibility and mutations, adult giver purchases, and scope-aware photo reads. Legacy child managers start null and can be claimed explicitly by an existing linked group member.
- [x] Run the focused tests; expect all passing, including foreign-key checks and unchanged photo cleanup behavior.

### Task 2: Preserve ownership and reminder behavior

**Files:** Modify `app/server/account.ts`, `app/server/wishlist-reminders.ts`, `app/server/mail.ts`, `tests/account.test.ts`, `tests/wishlist-reminders.test.ts`.

**Interfaces:** Task 1 changes `gift_items.owner_id` from membership to account ID and supplies nullable `group_id`, and `children.manager_id`. Keep existing account and reminder APIs.

- [x] Extend merge tests with shared wishes, managed children, and blocked-merge atomicity. Add reminder tests for a wish shared from another group and a wish private to another group, including queued delivery cancellation.
- [x] Run those tests and confirm the new cases fail before changing behavior.
- [x] Transfer shared wish/child ownership inside the guarded merge batch; update both reminder emptiness checks to include account-owned shared or matching-group wishes.
- [x] Run focused tests and the full Vitest suite; expect passing.

### Task 3: Sharing and reuse controls

**Files:** Modify `app/ui.tsx`, `app/styles.css`; create `app/wishlist-refresh.ts`; modify `tests/e2e/exchange.spec.ts`.

**Interfaces:** Consume Task 1's scope, management capabilities, and reusable child summaries. Forms submit the new intents and existing `actingMembershipId`; retain action feedback/reset behavior.

- [x] Add a browser flow for shared versus private adult wishes, hiding purchase flags from the owner, child reuse and synchronized purchases, and editing scope on existing wishes. Update the old per-group fixture to explicitly select exchange-specific scope.
- [x] Run the new browser cases; confirm missing controls/behavior fails.
- [x] Add default-shared scope selection, scope labels/editors, assigned-giver purchase controls, managed-child reuse and legacy claim controls. Refresh canonical data when the dashboard regains focus without disrupting pending submissions.
- [x] Run both mobile browser projects for the affected cases and inspect the mobile sharing controls; expect passing with no horizontal overflow.

### Task 4: Documentation and complete verification

**Files:** Modify `README.md`, `QUICKSTART.md`; update this plan with results.

**Interfaces:** Document the implemented labels, legacy handling, management rules, and required ordered migration.

- [x] Document shared wish behavior, Little One reuse, and the deployment migration requirement.
- [x] Run `npm run typecheck`, `npm test`, `npm run build`, and both sign-in modes of `npm run test:e2e`; inspect every result.
- [x] Request one independent whole-change review; address material issues with reproducing tests, then rerun affected checks.
- [x] Leave the completed local changes ready for review and report validation and any remaining limitations.

## Verification results

- Vitest: 87/87 passed, including populated D1 migration, canonical purchase state, scope and photo permissions, account merging, reminder eligibility, and stale membership reads.
- TypeScript: passed.
- Email browser suite: 18/18 passed across Mobile Chrome and Mobile WebKit.
- Password browser suite: 4/4 passed across Mobile Chrome and Mobile WebKit.
- Worker/client build: passed.
- Inspected the sharing controls at 320px with no horizontal overflow.
- Independent review findings resolved with regression tests. Existing duplicate child records intentionally remain separate; users explicitly reuse a canonical child in additional exchanges.
