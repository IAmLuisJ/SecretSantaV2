import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";
import { renderToReadableStream } from "react-dom/server";

export default async function handleDocument(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  const stream = await renderToReadableStream(<ServerRouter context={context} url={request.url} />, {
    signal: request.signal,
    onError() {
      status = 500;
      console.error("Rendering failed.");
    },
  });
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(stream, { headers, status });
}
