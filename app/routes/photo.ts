import type { Route } from "./+types/photo";
import { workerContext } from "../context";
import { readPhoto } from "../server/gifts";
import { verifiedUser } from "../server/http";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = context.get(workerContext);
  if (!/^[a-f0-9-]{36}$/i.test(params.id)) return new Response(null, { status: 404 });
  const user = await verifiedUser(request, env);
  return user ? readPhoto(env, user.id, params.id) : new Response(null, { status: 404 });
}
