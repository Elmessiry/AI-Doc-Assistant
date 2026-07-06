"use client";

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

// This file replaces the root layout when active, so the stylesheet the
// layout normally imports has to be pulled in here too.
import "./globals.css";

// Replaces the root layout when it crashes, so it must render its own
// <html>/<body> and carry its own styles — no layout, no globals.css.
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body className="flex min-h-dvh items-center justify-center bg-zinc-50 px-4 dark:bg-black">
        <div className="flex w-full max-w-sm flex-col items-start gap-3 rounded-2xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Something went wrong
          </h2>
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            An unexpected error occurred. It has been reported.
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-50 hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
