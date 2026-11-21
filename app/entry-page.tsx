import { useActionData, useLoaderData, useSearchParams } from "react-router";
import type { action, loader } from "./server/entry-route";
import { Entry, ExchangeList } from "./ui";

export default function EntryPage() {
  const { user, invite, exchanges, showExchanges, error, defaultYear, emailSignIn } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const [params] = useSearchParams();
  const mode = params.get("auth");
  const step = user ? "group"
    : result && "step" in result && result.step ? result.step
    : emailSignIn ? mode === "password" ? "password" : "email"
    : mode === "register" ? "register" : "password";
  const message = (result && "error" in result ? result.error : undefined) ?? error;
  if (user && showExchanges) {
    return <ExchangeList exchanges={exchanges} user={user} error={message} />;
  }
  return (
    <Entry
      user={user}
      invite={invite}
      step={step}
      emailSignIn={emailSignIn}
      defaultYear={defaultYear}
      values={result?.values ?? {}}
      error={message}
    />
  );
}
