import { useActionData, useLoaderData } from "react-router";
import type { action, loader } from "./server/entry-route";
import { Entry } from "./ui";

export default function EntryPage() {
  const { user, invite, error, defaultYear } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  return (
    <Entry
      user={user}
      invite={invite}
      step={result && "step" in result && result.step ? result.step : user ? "group" : "email"}
      defaultYear={defaultYear}
      values={result?.values ?? {}}
      error={(result && "error" in result ? result.error : undefined) ?? error}
    />
  );
}
