# Pull-request releases and heartbeat

The user requires pull requests for changes and normal deployment through the existing GitHub Actions CI/CD pipeline. Direct deployment remains allowed when that release path fails or is unavailable. Add the missing `.github/copilot-instructions.md` with that policy and keep contributor/release documentation aligned.

Add an unauthenticated, uncached `GET /heartbeat` resource route returning `{ status: "ok", commit, version, timestamp }`. `commit` identifies the source revision embedded during the build. `version` and `timestamp` come from Cloudflare's version metadata binding. Local builds identify themselves as `local`; remote builds require an explicit full commit SHA through `SANTA_BUILD_COMMIT`. The endpoint reads only release metadata and supports HEAD requests.

The canonical approach is a resource route using existing Worker bindings. No database health query or new external service is needed to identify a release. The CI build supplies its commit, then a post-deployment check polls the endpoint for that exact commit and valid platform version metadata. An older healthy release must fail this check. The check runs only if the deploy job actually released the current main revision.

The already-deployed shared-wishlist changes are still local and must be included in the pull request so the next pipeline release preserves the deployed schema and behavior. Preserve unrelated `.idea/` files and ignored local deployment receipts. Do not merge the pull request or deploy directly as part of this request unless the user subsequently asks or a release already authorized in this session needs the stated fallback.

Validate the heartbeat through real HTTP requests in both mobile browser projects; unit-test release response validation, mismatch handling, and bounded retries; run TypeScript, Vitest, and the build; open a pull request and follow its CI checks to completion.
