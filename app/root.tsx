import type { ReactNode } from "react";
import { isRouteErrorResponse, Link, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import { Layout as SiteLayout } from "./ui";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#10372e" />
        <link rel="icon" href="/santa.svg" type="image/svg+xml" />
        <title>Secret Santa</title>
        <Meta />
        <Links />
      </head>
      <body>
        <SiteLayout>{children}</SiteLayout>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <section className="error-page">
      <h1>{status === 404 ? "Page not found" : "This page could not load"}</h1>
      <p>{status === 404 ? "Check the link or head back to Secret Santa." : "Try again in a moment."}</p>
      <Link to="/">Return to Secret Santa</Link>
    </section>
  );
}
