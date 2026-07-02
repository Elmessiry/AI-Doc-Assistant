"use client";

import { useState } from "react";
import { DocumentList } from "./document-list";
import { UploadZone } from "./upload-zone";

type DashboardContentProps = {
  email: string;
};

export function DashboardContent({ email }: DashboardContentProps) {
  const [refreshKey, setRefreshKey] = useState(0);

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
