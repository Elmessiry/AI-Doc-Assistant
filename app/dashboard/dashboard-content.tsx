"use client";

import { useEffect, useState } from "react";
import posthog from "posthog-js";
import { DocumentList } from "./document-list";
import { UploadZone } from "./upload-zone";

type DashboardContentProps = {
  email: string;
  userId: string;
};

export function DashboardContent({ email, userId }: DashboardContentProps) {
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    // Link this browser's anonymous id to the user id — no PII properties.
    posthog.identify(userId);
  }, [userId]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 sm:gap-8 sm:px-6 sm:py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Documents
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Signed in as {email}
        </p>
      </header>

      {/* Informational only for now — the 3-document cap is not enforced yet. */}
      <div
        role="status"
        className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200"
      >
        <span className="font-semibold">Free plan:</span> 3 documents max.
      </div>

      <UploadZone onUploaded={() => setRefreshKey((key) => key + 1)} />
      <DocumentList refreshKey={refreshKey} />
    </div>
  );
}
