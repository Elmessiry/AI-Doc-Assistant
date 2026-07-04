import { createClient } from "@/lib/supabase/server";
import {
  chatCompletion,
  streamChatDeltas,
  type ChatMessage,
} from "@/lib/openrouter";

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

  // 3. RATE LIMIT: 30 messages per hour per user. The cost we're guarding is
  //    the model call, which no RLS policy can see — so we count this user's
  //    requests in a per-request log table over a rolling one-hour window.
  //    The counter lives in the DB (not memory) because serverless instances
  //    share no RAM. We filter on user_id explicitly (matching the insert
  //    below) rather than leaning on RLS alone: a too-permissive policy would
  //    otherwise let this count everyone's rows and mis-fire for all users.
  const RATE_WINDOW_MS = 60 * 60 * 1000;
  const RATE_MAX = 30;
  const windowStart = new Date(Date.now() - RATE_WINDOW_MS).toISOString();

  const { count, error: rateError } = await supabase
    .from("chat_requests")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", windowStart);

  if (rateError) {
    // Fail closed: if we can't verify the limit, don't spend on the model.
    console.error("chat: rate-limit count failed:", rateError.message);
    return Response.json(
      { error: "Could not verify rate limit" },
      { status: 500 },
    );
  }

  if ((count ?? 0) >= RATE_MAX) {
    return Response.json(
      { error: "Rate limit reached — 30 messages per hour. Try again later." },
      { status: 429 },
    );
  }

  // 4. RETRIEVAL. v1 strategy: fetch *all* chunks for this document, ordered
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

  // 5. Record this request for the rate-limit window. We log only now — after
  //    retrieval succeeds — so validation errors and 404s don't count against
  //    the user. RLS's own check ties the row to auth.uid(); we pass user_id
  //    explicitly for clarity. (Check-then-insert isn't atomic, so a burst of
  //    concurrent requests could slip a couple over 30 — acceptable here.)
  const { error: logError } = await supabase
    .from("chat_requests")
    .insert({ user_id: user.id });

  if (logError) {
    console.error("chat: rate-limit log insert failed:", logError.message);
    return Response.json(
      { error: "Could not record request" },
      { status: 500 },
    );
  }

  // 6. GENERATION. Glue the chunks back into one context blob (blank line
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

  // 7. Ask the model, streaming. On stream:true OpenRouter still replies with
  //    a normal JSON error (and non-200 status) if something is wrong up front,
  //    so we can check res.ok BEFORE we commit to a streaming response.
  let modelRes: Response;
  try {
    modelRes = await chatCompletion(messages, { stream: true });
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

  // 8. Bridge the model's SSE stream to a plain-text stream for the browser:
  //    parse each delta server-side, enqueue the raw token. The browser reads
  //    response.body and appends strings — no SSE parsing needed on the client.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of streamChatDeltas(modelRes)) {
          controller.enqueue(encoder.encode(delta));
        }
      } catch (err) {
        // Mid-stream failure: status/headers are already sent, so we can't turn
        // this into a 5xx. Log it and close cleanly — the client sees a short
        // (or empty) answer rather than a hang.
        console.error("chat: stream interrupted:", err);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      // Plain text, streamed via chunked transfer encoding. no-store keeps
      // proxies/browser from caching a half-answer.
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
