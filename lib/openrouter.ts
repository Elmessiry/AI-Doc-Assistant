// Thin client for OpenRouter's Chat Completions API.
//
// OpenRouter exposes an OpenAI-compatible endpoint that proxies many models
// behind one URL. We call it with plain `fetch` (no SDK) on purpose: it keeps
// the streaming (Server-Sent Events) path visible and adds zero dependencies.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

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
export function chatCompletion(
  messages: ChatMessage[],
  { stream = false }: { stream?: boolean } = {},
): Promise<Response> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // A missing key is a deploy/config mistake, not a user error — fail loud
    // on the server. This throw never reaches the browser.
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  return fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: CHAT_MODEL, messages, stream }),
  });
}
