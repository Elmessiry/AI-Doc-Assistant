"use client";

import { useCallback, useRef, useState } from "react";
import posthog from "posthog-js";
import * as Sentry from "@sentry/nextjs";
import { createClient } from "@/lib/supabase/client";

const MAX_FILE_SIZE_MB = 1;
// Bytes, using binary MiB to match Supabase's bucket size limit.
const MAX_FILE_SIZE = MAX_FILE_SIZE_MB * 1024 * 1024;

// Supabase Storage object keys only accept safe ASCII; "ü", spaces, etc.
// trigger an "Invalid key" error. Fold accents to ASCII, then replace
// anything still unsafe. The original name is kept in the file_name column.
function sanitizeKey(name: string): string {
  return name
    .normalize("NFKD") // "ü" -> "u" + combining diaeresis
    .replace(/[\u0300-\u036f]/g, "") // strip combining marks (U+0300–U+036F)
    .replace(/[^a-zA-Z0-9._-]/g, "_"); // any remaining unsafe char -> "_"
}

type UploadZoneProps = {
  onUploaded?: () => void;
};

export function UploadZone({ onUploaded }: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      setError(null);

      // Fail fast in the browser so we never upload bytes we'd only reject.
      // The bucket enforces this too, but this gives a friendly message first.
      if (file.size > MAX_FILE_SIZE) {
        posthog.capture("document_upload_failed", {
          failure_reason: "file_too_large",
          file_size_bytes: file.size,
        });
        setError(
          `File is too large — the maximum size is ${MAX_FILE_SIZE_MB} MB.`,
        );
        return;
      }

      setUploading(true);

      try {
        const supabase = createClient();
        const {
          data: { user },
          error: authError,
        } = await supabase.auth.getUser();

        if (authError) {
          setError(authError.message);
          return;
        }

        if (!user) {
          setError("Sign in to upload files.");
          return;
        }

        const storagePath = `${user.id}/${crypto.randomUUID()}-${sanitizeKey(file.name)}`;

        const { error: uploadError } = await supabase.storage
          .from("documents")
          .upload(storagePath, file);

        if (uploadError) {
          posthog.capture("document_upload_failed", {
            failure_reason: "storage_error",
          });
          setError(uploadError.message);
          return;
        }

        const { data: inserted, error: insertError } = await supabase
          .from("documents")
          .insert({
            user_id: user.id,
            file_name: file.name,
            file_size: file.size,
            storage_path: storagePath,
          })
          .select("id")
          .single();

        // Treat a missing row the same as an error: if the insert didn't
        // return the new id (e.g. insert ok but the select failed), we can't
        // start processing, so roll back the stored bytes.
        if (insertError || !inserted) {
          posthog.capture("document_upload_failed", {
            failure_reason: "database_error",
          });
          await supabase.storage.from("documents").remove([storagePath]);
          setError(insertError?.message ?? "Could not save the document.");
          return;
        }

        posthog.capture("document_uploaded", {
          file_size_bytes: file.size,
        });

        // Kick off text extraction. Fire-and-forget: the upload has already
        // succeeded, so a processing hiccup must not fail the UI here. The
        // route is the single source of truth for the document's status
        // (including rejecting non-PDFs), so fire it for every upload.
        // Same-origin fetch carries the auth cookie, so the route sees this user.
        fetch("/api/process-document", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-POSTHOG-DISTINCT-ID": posthog.get_distinct_id() ?? "",
            "X-POSTHOG-SESSION-ID": posthog.get_session_id() ?? "",
          },
          body: JSON.stringify({ documentId: inserted.id }),
        }).catch(() => {
          // Fire-and-forget: the document list reflects processing status via
          // polling, so a failed kickoff (offline, navigation) needs no
          // handling here — just swallow the rejection.
        });

        onUploaded?.();
      } catch (err) {
        // An unexpected throw (SDK/runtime) — surface it and never leave
        // the zone stuck in the uploading state.
        Sentry.captureException(err);
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploading(false);
      }
    },
    [onUploaded],
  );

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void uploadFile(file);
    },
    [uploadFile],
  );

  return (
    <section aria-labelledby="upload-heading">
      <h2 id="upload-heading" className="sr-only">
        Upload documents
      </h2>

      <div
        role="button"
        tabIndex={uploading ? -1 : 0}
        aria-disabled={uploading}
        aria-label="Upload a document"
        onClick={() => !uploading && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !uploading) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!uploading) setDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (!uploading) handleFiles(e.dataTransfer.files);
        }}
        className={[
          "rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
          dragging
            ? "border-zinc-900 bg-zinc-50 dark:border-zinc-100 dark:bg-zinc-900"
            : "border-zinc-300 dark:border-zinc-700",
          uploading
            ? "cursor-not-allowed opacity-60"
            : "cursor-pointer hover:border-zinc-400 dark:hover:border-zinc-500",
        ].join(" ")}
      >
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          disabled={uploading}
          onChange={(e) => {
            handleFiles(e.target.files);
            // Reset so selecting the SAME file again still fires onChange.
            e.target.value = "";
          }}
        />

        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {uploading ? "Uploading…" : "Drop a file here, or click to browse"}
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Files are stored in your private folder
        </p>
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </section>
  );
}
