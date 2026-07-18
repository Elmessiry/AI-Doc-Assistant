// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes an OpenAI-compatible endpoint that proxies many models
// behind one URL. We call it with plain `fetch` (no SDK) on purpose: it keeps
// the streaming (Server-Sent Events) path visible and adds zero dependencies.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// Two ways an OpenRouter call can stall, each with its own bound so a hung
// upstream never pins a serverless instance open forever: waiting for the
// response to begin, and waiting for the next chunk once a stream is flowing.
// Both are generous — the model can be genuinely slow — but finite.
const RESPONSE_TIMEOUT_MS = 30_000; // time to the response headers (first byte)
const STREAM_IDLE_TIMEOUT_MS = 30_000; // max gap allowed between streamed chunks

// Links the AbortController that owns a request to its Response, so the stream
// reader (streamChatDeltas) can re-arm an idle timeout on the same controller
// without the caller having to thread it through. Weak keys let the entry drop
// once the Response is gone.
const requestControllers = new WeakMap<Response, AbortController>();

// mistral-nemo: cheap (~$0.02/$0.03 per M tokens), fast, 128k context — good
// for demo Q&A over a whole document. Verified live against OpenRouter's model
// list; ids drift, so confirm one exists before swapping it here.
export const CHAT_MODEL = "mistralai/mistral-nemo";

// The three roles a chat completion understands. `system` sets the rules,
// `user` is the question, `assistant` is the model's reply (used when we
// replay prior turns back to the model).
export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Sends a chat completion request and hands back the raw fetch Response so the
// caller decides how to read it: `.json()` for a whole answer, or `.body` as a
// stream when `stream: true`. The API key is read here, server-side only.
export async function chatCompletion(
  messages: ChatMessage[],
  { stream = false }: { stream?: boolean } = {},
): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // A missing key is a deploy/config mistake, not a user error — fail loud
    // on the server. This throw never reaches the browser.
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  // One controller per request. The response timeout arms it now; the stream
  // reader re-arms the same controller per chunk. Aborting tears down both the
  // fetch and its body stream, freeing the socket either way.
  const controller = new AbortController();
  const responseTimer = setTimeout(
    () => controller.abort(),
    RESPONSE_TIMEOUT_MS,
  );

  try {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: CHAT_MODEL, messages, stream }),
      signal: controller.signal,
    });
    // Headers are in, so the response-timeout job is done. Hand the controller
    // off to the stream reader (via the WeakMap) to guard the chunk gaps.
    requestControllers.set(res, controller);
    return res;
  } finally {
    clearTimeout(responseTimer);
  }
}

// Parses a streaming chat Response (call chatCompletion with stream: true) and
// yields just the text deltas as they arrive.
//
// SSE framing: events are separated by a blank line; each carries one or more
// `data: <payload>` lines. The stream ends with a literal `data: [DONE]`.
// Every payload (except [DONE]) is a JSON chunk whose choices[0].delta.content
// holds the next piece of text — sometimes empty, which we skip. OpenRouter
// also sends `: ...` comment lines as keep-alives; those aren't `data:` so
// they fall through untouched.
export async function* streamChatDeltas(res: Response): AsyncGenerator<string> {
  if (!res.body) throw new Error("streaming response has no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Idle guard: re-armed after every successful read, so a stall longer than
  // STREAM_IDLE_TIMEOUT_MS between chunks aborts the request. The abort rejects
  // the in-flight reader.read() (AbortError), which surfaces to the caller as a
  // stream interruption rather than an indefinite hang. Aborts the shared
  // controller from chatCompletion, so the underlying fetch is torn down too.
  const controller = requestControllers.get(res);
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (!controller) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => controller.abort(), STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    armIdle();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();

      // A single network read may contain several events, or half of one — so
      // we accumulate and only process complete, blank-line-terminated events,
      // leaving any trailing partial in the buffer for the next read.
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        for (const line of event.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (payload === "[DONE]") return;

          try {
            const json = JSON.parse(payload);
            const text = json?.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text.length > 0) yield text;
          } catch {
            // Non-JSON keep-alive or a partial line — ignore and move on.
          }
        }
      }
    }
  } finally {
    clearTimeout(idleTimer);
  }
}
