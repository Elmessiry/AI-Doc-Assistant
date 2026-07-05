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
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-6 py-12">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Documents
        </h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Signed in as {email}
        </p>
      </header>

      <UploadZone onUploaded={() => setRefreshKey((key) => key + 1)} />
      <DocumentList refreshKey={refreshKey} />
    </div>
  );
}
