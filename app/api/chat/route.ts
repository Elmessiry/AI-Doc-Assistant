import { createClient } from "@/lib/supabase/server";
import { chatCompletion, type ChatMessage } from "@/lib/openrouter";

// Default (Node.js) runtime is fine here: no pdf.js, just a DB read and — in
// the next step — an outbound fetch to OpenRouter. Both run on Node.

export async function POST(req: Request) {
  const supabase = await createClient();

  // 1. Authenticate. The browser fetch carries the session cookie, so the
  //    server client resolves the same user who owns the document.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Read + validate the body. Malformed JSON throws → 400.
  let message: unknown;
  let documentId: unknown;
  try {
    ({ message, documentId } = await req.json());
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof message !== "string" || message.trim().length === 0) {
    return Response.json(
      { error: "message (non-empty string) is required" },
      { status: 400 },
    );
  }

  if (typeof documentId !== "string" || documentId.length === 0) {
    return Response.json(
      { error: "documentId (string) is required" },
      { status: 400 },
    );
  }

  // 3. RETRIEVAL. v1 strategy: fetch *all* chunks for this document, ordered
  //    so the model reads them in the document's own sequence. RLS on
  //    document_chunks limits this to the caller's rows, so another user's id
  //    simply returns nothing rather than leaking content.
  const { data: chunks, error: chunksError } = await supabase
    .from("document_chunks")
    .select("content")
    .eq("document_id", documentId)
    .order("chunk_index", { ascending: true });

  if (chunksError) {
    console.error("chat: chunk fetch failed:", chunksError.message);
    return Response.json(
      { error: "Could not load document content" },
      { status: 500 },
    );
  }

  // No chunks means the document isn't yours, doesn't exist, or hasn't been
  // processed yet — from the caller's side these are indistinguishable, and
  // all mean "there's nothing to answer from."
  if (!chunks || chunks.length === 0) {
    return Response.json(
      { error: "This document has no processed content to chat with yet." },
      { status: 404 },
    );
  }

  // 4. GENERATION. Glue the chunks back into one context blob (blank line
  //    between chunks so the model reads them as distinct passages), then
  //    assemble the chat messages.
  const context = chunks.map((c) => c.content).join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You answer questions about the user's document. Use only the " +
        "information in the provided context. If the answer is not in the " +
        "context, say you don't know — do not invent facts.",
    },
    {
      role: "user",
      content: `Context from the document:\n\n${context}\n\nQuestion: ${message}`,
    },
  ];

  // 5. Ask the model. Non-streaming for now: wait for the whole answer, then
  //    return it as JSON. Streaming is the next commit.
  let modelRes: Response;
  try {
    modelRes = await chatCompletion(messages, { stream: false });
  } catch (err) {
    // Thrown only when the key is missing — a server config problem.
    console.error("chat: could not start model request:", err);
    return Response.json({ error: "Chat is not configured" }, { status: 500 });
  }

  if (!modelRes.ok) {
    // Log the upstream detail server-side; return a generic 502 to the client.
    console.error("chat: model error", modelRes.status, await modelRes.text());
    return Response.json(
      { error: "The model could not answer right now" },
      { status: 502 },
    );
  }

  const data = await modelRes.json();
  const answer = data?.choices?.[0]?.message?.content;
  if (typeof answer !== "string") {
    console.error("chat: unexpected model response shape");
    return Response.json(
      { error: "The model returned no answer" },
      { status: 502 },
    );
  }

  return Response.json({ answer });
}
