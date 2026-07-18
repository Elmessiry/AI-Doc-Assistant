"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/client";
import { ChatPanel } from "./chat-panel";

export type DocumentStatus = "pending" | "processing" | "processed" | "failed";

export type Document = {
  id: string;
  file_name: string;
  file_size: number;
  storage_path: string;
  created_at: string;
  status: DocumentStatus;
  status_detail: string | null;
};

type DocumentListProps = {
  refreshKey?: number;
};

// How often to re-check documents that are still being processed.
const POLL_INTERVAL_MS = 2000;

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}

const STATUS_STYLES: Record<
  DocumentStatus,
  { label: string; className: string }
> = {
  pending: {
    label: "Queued",
    className: "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  },
  processing: {
    label: "Processing…",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-400",
  },
  processed: {
    label: "Searchable",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400",
  },
  failed: {
    label: "Failed",
    className: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400",
  },
};

function StatusBadge({ status }: { status: DocumentStatus }) {
  const { label, className } = STATUS_STYLES[status];
  return (
    <span
      className={`inline-block shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {label}
    </span>
  );
}

export function DocumentList({ refreshKey = 0 }: DocumentListProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  // The document whose chat panel is open, or null when the panel is closed.
  const [chatDoc, setChatDoc] = useState<Document | null>(null);

  // `silent` skips the full-screen loading state so background polling
  // doesn't blank the list every couple of seconds.
  //
  // The refreshKey effect and the poll timer can both have a fetch in flight
  // at once, with no guarantee they resolve in the order they started. Each
  // call is tagged with a ticket; only the response whose ticket still
  // matches the latest call is allowed to commit state, so a slow, stale
  // response can't overwrite what a newer one already wrote (e.g. making a
  // just-uploaded document briefly vanish).
  const requestIdRef = useRef(0);

  const fetchDocuments = useCallback(async (silent = false) => {
    const requestId = ++requestIdRef.current;
    if (!silent) setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select(
          "id, file_name, file_size, storage_path, created_at, status, status_detail",
        )
        .order("created_at", { ascending: false });

      if (requestIdRef.current !== requestId) return;

      if (fetchError) {
        // A background poll must not blow away the visible list on a transient
        // error — keep the current documents (a new array ref so the poll
        // effect re-runs and retries) and only surface the error to the user
        // on a foreground load.
        if (silent) {
          setDocuments((prev) => [...prev]);
        } else {
          setError(fetchError.message);
          setDocuments([]);
        }
      } else {
        setDocuments(data ?? []);
      }
    } catch (err) {
      if (requestIdRef.current !== requestId) return;

      if (silent) {
        setDocuments((prev) => [...prev]);
      } else {
        setError(
          err instanceof Error ? err.message : "Failed to load documents.",
        );
        setDocuments([]);
      }
    } finally {
      if (!silent && requestIdRef.current === requestId) setLoading(false);
    }
  }, []);

  const deleteDocument = useCallback(async (doc: Document) => {
    setError(null);
    setDeletingId(doc.id);

    try {
      const supabase = createClient();

      // Remove the bytes first, then the metadata row. Bytes-first is
      // retryable: if the row delete fails the row remains, so the user can
      // click delete again and it self-heals. The tradeoff is a brief window
      // where the row still shows but its file is already gone.
      const { error: storageError } = await supabase.storage
        .from("documents")
        .remove([doc.storage_path]);

      if (storageError) {
        setError(storageError.message);
        return;
      }

      const { error: deleteError } = await supabase
        .from("documents")
        .delete()
        .eq("id", doc.id);

      if (deleteError) {
        setError(deleteError.message);
        return;
      }

      // Drop it from local state immediately; no full refetch needed.
      posthog.capture("document_deleted");
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
    } catch (err) {
      Sentry.captureException(err);
      setError(
        err instanceof Error ? err.message : "Failed to delete document.",
      );
    } finally {
      setDeletingId(null);
    }
  }, []);

  const openChat = useCallback((doc: Document) => {
    posthog.capture("chat_opened");
    setChatDoc(doc);
  }, []);

  // Fetch on mount and whenever a new upload bumps refreshKey. The list is
  // server data, not state derivable during render, so an effect is the right
  // tool here — the synchronous setLoading/setError inside fetchDocuments is
  // intentional (it shows the loading state), which is what the lint rule
  // flags. Suppress it deliberately rather than contort a correct fetch.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void fetchDocuments();
  }, [fetchDocuments, refreshKey]);

  // While any document is still being processed, poll quietly until every
  // document reaches a terminal state (processed or failed). This effect
  // re-runs whenever `documents` changes, so it self-terminates.
  useEffect(() => {
    const stillWorking = documents.some(
      (d) => d.status === "pending" || d.status === "processing",
    );
    if (!stillWorking) return;

    const timer = setTimeout(() => void fetchDocuments(true), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [documents, fetchDocuments]);

  if (loading) {
    return <p className="text-sm text-zinc-500 dark:text-zinc-400">Loading…</p>;
  }

  if (error) {
    return (
      <p role="alert" className="text-sm text-red-600 dark:text-red-400">
        {error}
      </p>
    );
  }

  if (documents.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No documents yet. Upload your first file above.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {documents.map((doc) => {
          const info = (
            <>
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {doc.file_name}
                </p>
                <StatusBadge status={doc.status} />
              </div>
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                {formatBytes(doc.file_size)} · {formatDate(doc.created_at)}
              </p>
              {doc.status === "failed" && doc.status_detail && (
                <p className="mt-0.5 text-xs text-red-600 dark:text-red-400">
                  {doc.status_detail}
                </p>
              )}
            </>
          );

          return (
          <li
            key={doc.id}
            className="flex items-center justify-between gap-4 px-4 py-3"
          >
            {doc.status === "processed" ? (
              // A processed document's whole row (not just the small Chat
              // button) opens its chat — the primary action gets the big
              // target. Other statuses have no chat to open, so plain text.
              <button
                type="button"
                onClick={() => openChat(doc)}
                aria-label={`Open chat about ${doc.file_name}`}
                className="min-w-0 flex-1 cursor-pointer rounded-md text-left"
              >
                {info}
              </button>
            ) : (
              <div className="min-w-0 flex-1">{info}</div>
            )}

            <div className="flex shrink-0 items-center gap-1">
              {doc.status === "processed" && (
                <button
                  type="button"
                  onClick={() => openChat(doc)}
                  aria-label={`Chat about ${doc.file_name}`}
                  className="rounded-md px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  Chat
                </button>
              )}

              <button
                type="button"
                onClick={() => void deleteDocument(doc)}
                disabled={deletingId !== null}
                aria-label={`Delete ${doc.file_name}`}
                className="rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
              >
                {deletingId === doc.id ? "Deleting…" : "Delete"}
              </button>
            </div>
          </li>
          );
        })}
      </ul>

      {chatDoc && (
        <ChatPanel
          documentId={chatDoc.id}
          fileName={chatDoc.file_name}
          onClose={() => setChatDoc(null)}
        />
      )}
    </>
  );
}
