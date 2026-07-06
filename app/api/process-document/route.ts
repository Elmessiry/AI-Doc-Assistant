import { PDFParse } from "pdf-parse";
import { createClient } from "@/lib/supabase/server";
import { captureServerEvent } from "@/lib/posthog-server";
import { chunkText } from "@/lib/chunk";

// pdf-parse wraps Mozilla's pdf.js — heavy CPU work and Node-flavored
// internals that do not run on the Edge runtime. Pin this route to Node.
export const runtime = "nodejs";

type Status = "processing" | "processed" | "failed";

// Scanned/image-only PDFs have no text layer, but often still yield a few
// stray characters (a page number, a header). Requiring a minimum amount of
// real text separates a genuine document from an image with incidental text.
// Heuristic — tune if a legitimately tiny PDF is ever wrongly rejected.
const MIN_TEXT_LENGTH = 100;

export async function POST(req: Request) {
  const supabase = await createClient();

  // 1. Authenticate. The browser fetch sends the session cookie, so the
  //    server client reads the same user that uploaded the file.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Read the body. A malformed JSON payload throws — catch it as a 400.
  let documentId: string | undefined;
  try {
    ({ documentId } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof documentId !== "string" || documentId.length === 0) {
    return Response.json(
      { error: "documentId (string) is required" },
      { status: 400 },
    );
  }

  // Records the outcome on the document row so the UI can show it. Scoped to
  // this id, which RLS already restricts to the caller's own rows.
  const mark = (status: Status, detail: string | null = null) =>
    supabase
      .from("documents")
      .update({ status, status_detail: detail })
      .eq("id", documentId);

  // 3. Fetch the metadata row. RLS on `documents` limits this to the
  //    caller's own rows, so someone else's id simply comes back null → 404.
  const { data: doc, error: docError } = await supabase
    .from("documents")
    .select("id, file_name, storage_path")
    .eq("id", documentId)
    .single();

  if (docError || !doc) {
    return Response.json({ error: "Document not found" }, { status: 404 });
  }

  // The bucket accepts any file type; the parser only understands PDFs.
  if (!doc.file_name.toLowerCase().endsWith(".pdf")) {
    await mark("failed", "Only PDF files can be processed.");
    captureServerEvent(req, user.id, "document_processing_failed", {
      failure_reason: "unsupported_file_type",
    });
    return Response.json(
      { error: "Only PDF files can be processed" },
      { status: 415 },
    );
  }

  // If we can't even record "processing", DB writes are failing — bail before
  // doing the expensive download + parse work, and don't leave the UI polling
  // a doc that will never move past "pending".
  const { error: processingError } = await mark("processing");
  if (processingError) {
    return Response.json(
      { error: "Could not update document status" },
      { status: 500 },
    );
  }

  // Clear any chunks from a previous run up front. This makes reprocessing
  // idempotent AND guarantees a doc that ends up "failed" has no leftover
  // chunks — a non-searchable doc should never have searchable content.
  // If this fails, stop now: continuing could leave stale chunks behind
  // while we later mark the doc processed, breaking that guarantee.
  const { error: clearError } = await supabase
    .from("document_chunks")
    .delete()
    .eq("document_id", doc.id);

  if (clearError) {
    await mark(
      "failed",
      "Could not clear previous chunks before reprocessing.",
    );
    return Response.json(
      { error: "Could not clear existing chunks" },
      { status: 500 },
    );
  }

  // 4. Download the bytes from private storage. Returns a Blob.
  const { data: blob, error: downloadError } = await supabase.storage
    .from("documents")
    .download(doc.storage_path);

  if (downloadError || !blob) {
    await mark("failed", "Could not download the file from storage.");
    return Response.json({ error: "Could not download file" }, { status: 502 });
  }

  // 5. Extract text. Always destroy() the parser to free pdf.js resources.
  const buffer = new Uint8Array(await blob.arrayBuffer());
  const parser = new PDFParse({ data: buffer });

  let text: string;
  try {
    const result = await parser.getText();
    text = result.text;
  } catch {
    await mark("failed", "The PDF could not be read (it may be corrupt).");
    return Response.json({ error: "Could not read PDF" }, { status: 422 });
  } finally {
    await parser.destroy();
  }

  // 6. Gate on how much real text came out. There is no OCR here — only
  //    embedded-text extraction — so an image-only PDF produces little or
  //    nothing. Collapse whitespace first so stray spaces don't count.
  const meaningfulText = text.replace(/\s+/g, " ").trim();
  if (meaningfulText.length < MIN_TEXT_LENGTH) {
    await mark(
      "failed",
      "Little or no selectable text found — scanned or image-only PDFs aren't supported.",
    );
    captureServerEvent(req, user.id, "document_processing_failed", {
      failure_reason: "insufficient_text",
    });
    return Response.json(
      { error: "Not enough extractable text in this PDF" },
      { status: 422 },
    );
  }

  // Pass the already-cleaned text; chunkText's own whitespace collapse is
  // idempotent, so this avoids re-scanning the raw string a second time.
  const chunks = chunkText(meaningfulText);

  // 7. Bulk-insert the fresh set in a single round trip. Prior chunks were
  //    already cleared above when processing began.
  const rows = chunks.map((content, chunk_index) => ({
    document_id: doc.id,
    user_id: user.id,
    content,
    chunk_index,
  }));

  const { error: insertError } = await supabase
    .from("document_chunks")
    .insert(rows);

  if (insertError) {
    // Keep the DB detail server-side; don't leak it to the client.
    console.error("document_chunks insert failed:", insertError.message);
    await mark("failed", "Text was extracted but chunks could not be saved.");
    return Response.json(
      { error: "Could not save document chunks" },
      { status: 500 },
    );
  }

  await mark("processed");
  captureServerEvent(req, user.id, "document_processed", {
    chunk_count: rows.length,
  });
  return Response.json({ documentId: doc.id, chunks: rows.length });
}
