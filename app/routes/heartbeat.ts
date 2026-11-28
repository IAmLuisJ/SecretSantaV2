import type { Route } from "./+types/heartbeat";
import { workerContext } from "../context";

export function loader({ context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  return Response.json({
    status: "ok",
    commit: env.BUILD_COMMIT ?? "unknown",
    version: env.WORKER_VERSION?.id ?? null,
    timestamp: env.WORKER_VERSION?.timestamp ?? null,
  }, { headers: { "Cache-Control": "no-store" } });
}
