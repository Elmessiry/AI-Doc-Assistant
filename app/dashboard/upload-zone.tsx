"use client";

import { useCallback, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";

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
      setUploading(true);

      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();

      if (!user) {
        setError("Sign in to upload files.");
        setUploading(false);
        return;
      }

      const storagePath = `${user.id}/${crypto.randomUUID()}-${file.name}`;

      const { error: uploadError } = await supabase.storage
        .from("documents")
        .upload(storagePath, file);

      if (uploadError) {
        setError(uploadError.message);
        setUploading(false);
        return;
      }

      const { error: insertError } = await supabase.from("documents").insert({
        user_id: user.id,
        file_name: file.name,
        file_size: file.size,
        storage_path: storagePath,
      });

      if (insertError) {
        await supabase.storage.from("documents").remove([storagePath]);
        setError(insertError.message);
        setUploading(false);
        return;
      }

      setUploading(false);
      onUploaded?.();
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
        tabIndex={0}
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
          onChange={(e) => handleFiles(e.target.files)}
        />

        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {uploading ? "Uploading…" : "Drop a file here, or click to browse"}
        </p>
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
          Files are stored in your private folder
        </p>
      </div>

      {error && (
        <p
          role="alert"
          className="mt-3 text-sm text-red-600 dark:text-red-400"
        >
          {error}
        </p>
      )}
    </section>
  );
}
