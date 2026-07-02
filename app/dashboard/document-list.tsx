"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type Document = {
  id: string;
  file_name: string;
  file_size: number;
  storage_path: string;
  created_at: string;
};

type DocumentListProps = {
  refreshKey?: number;
};

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

export function DocumentList({ refreshKey = 0 }: DocumentListProps) {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchDocuments = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("documents")
        .select("id, file_name, file_size, storage_path, created_at")
        .order("created_at", { ascending: false });

      if (fetchError) {
        setError(fetchError.message);
        setDocuments([]);
      } else {
        setDocuments(data ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load documents.");
      setDocuments([]);
    } finally {
      setLoading(false);
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
      setDocuments((docs) => docs.filter((d) => d.id !== doc.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete document.");
    } finally {
      setDeletingId(null);
    }
  }, []);

  useEffect(() => {
    void fetchDocuments();
  }, [fetchDocuments, refreshKey]);

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
    <ul className="divide-y divide-zinc-200 rounded-xl border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
      {documents.map((doc) => (
        <li
          key={doc.id}
          className="flex items-center justify-between gap-4 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
              {doc.file_name}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {formatBytes(doc.file_size)} · {formatDate(doc.created_at)}
            </p>
          </div>

          <button
            type="button"
            onClick={() => void deleteDocument(doc)}
            disabled={deletingId !== null}
            aria-label={`Delete ${doc.file_name}`}
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50 dark:text-red-400 dark:hover:bg-red-950"
          >
            {deletingId === doc.id ? "Deleting…" : "Delete"}
          </button>
        </li>
      ))}
    </ul>
  );
}
