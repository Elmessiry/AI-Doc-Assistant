import { after } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { captureServerEvent } from "@/lib/posthog-server";
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
    captureServerEvent(req, user.id, "chat_rate_limited");
    return Response.json(
      { error: "Rate limit reached — 30 messages per hour. Try again later." },
      { status: 429 },
    );
  }

  // 4. RETRIEVAL. v1 strategy: fetch *all* chunks for this document, ordered
  //    so the model reads them in the document's own sequence. RLS on
  //    document_chunks limits this to the caller's rows, so another user's id
  //    simply returns nothing rather than leaking content. We still filter on
  //    user_id explicitly — same reasoning as the rate-limit query above: don't
  //    lean on RLS alone in case a policy is ever loosened.
  const { data: chunks, error: chunksError } = await supabase
    .from("document_chunks")
    .select("content")
    .eq("user_id", user.id)
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

  // 5. CONVERSATION MEMORY. The UI shows a continuous conversation, so the
  //    model must see it too — otherwise "summarize that" has no antecedent.
  //    Load the latest turns (newest-first so LIMIT keeps the most recent,
  //    then back into chronological order). Best-effort: without history the
  //    model still answers the standalone question.
  const HISTORY_LIMIT = 10;
  const { data: history, error: historyError } = await supabase
    .from("messages")
    .select("role, content")
    .eq("user_id", user.id)
    .eq("document_id", documentId)
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);

  if (historyError) {
    console.error("chat: history fetch failed:", historyError.message);
  }

  const historyMessages = ((history ?? []) as ChatMessage[]).reverse();

  // 6. GENERATION. Glue the chunks back into one context blob (blank line
  //    between chunks so the model reads them as distinct passages). The
  //    document context lives in the system message so every user turn —
  //    past and present — stays a plain question.
  const context = chunks.map((c) => c.content).join("\n\n");

  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You answer questions about the user's document. Use only the " +
        "information in the provided context. If the answer is not in the " +
        "context, say you don't know — do not invent facts.\n\n" +
        `Context from the document:\n\n${context}`,
    },
    ...historyMessages,
    { role: "user", content: message },
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

  // 8. Record this request for the rate-limit window. We tick the counter only
  //    now — after the model call is confirmed OK — so validation errors, 404s,
  //    and upstream 5xx/502s don't burn a user's slot. RLS's own check ties the
  //    row to auth.uid(); we pass user_id explicitly for clarity. (Check-then-
  //    insert isn't atomic, so a burst of concurrent requests could slip a
  //    couple over 30 — acceptable here.)
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

  // 9. Persist the question — only now that an answer is actually coming, so
  //    a refused model call leaves no orphan question in the history. History
  //    is best-effort: a failed insert logs but never blocks the answer.
  //    (Consts because TypeScript drops `let` narrowing inside the stream
  //    closure below.)
  const docId = documentId;
  const question = message;

  const { error: userMsgError } = await supabase.from("messages").insert({
    user_id: user.id,
    document_id: docId,
    role: "user",
    content: question,
  });
  if (userMsgError) {
    console.error("chat: user message insert failed:", userMsgError.message);
  }

  // 10. Persist the answer and record completion AFTER the stream closes.
  //    Holding controller.close() hostage to a DB insert means the client's
  //    reader never sees done while the insert stalls — the Send button stays
  //    stuck even though the whole answer is on screen. Registering the work
  //    with after() (in handler scope, backed by waitUntil on serverless)
  //    keeps the instance alive until the deferred writes settle.
  let resolveStream!: (result: { answer: string; completed: boolean }) => void;
  const streamResult = new Promise<{ answer: string; completed: boolean }>(
    (resolve) => {
      resolveStream = resolve;
    },
  );

  after(async () => {
    const { answer, completed } = await streamResult;
    // Save whatever reached the client — after an interruption a partial
    // answer still matches what the user saw. Same best-effort rule as the
    // question insert: log failures, never surface them.
    if (answer.trim().length > 0) {
      const { error: answerMsgError } = await supabase.from("messages").insert({
        user_id: user.id,
        document_id: docId,
        role: "assistant",
        content: answer,
      });
      if (answerMsgError) {
        console.error(
          "chat: assistant message insert failed:",
          answerMsgError.message,
        );
      }
    }
    if (completed) {
      captureServerEvent(req, user.id, "chat_completed");
    }
  });

  // 11. Bridge the model's SSE stream to a plain-text stream for the browser:
  //    parse each delta server-side, enqueue the raw token. The browser reads
  //    response.body and appends strings — no SSE parsing needed on the client.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let answer = "";
      let completed = false;
      try {
        for await (const delta of streamChatDeltas(modelRes)) {
          answer += delta;
          controller.enqueue(encoder.encode(delta));
        }
        completed = true;
      } catch (err) {
        // Mid-stream failure: status/headers are already sent, so we can't turn
        // this into a 5xx. Log it and close cleanly — the client sees a short
        // (or empty) answer rather than a hang.
        console.error("chat: stream interrupted:", err);
      } finally {
        // Signal persistence BEFORE closing: when the client disconnects the
        // stream is already cancelled and close() throws — a throw here must
        // not stop the partial answer from being saved.
        resolveStream({ answer, completed });
        try {
          controller.close();
        } catch {
          // Client already cancelled the stream — nothing left to close.
        }
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
