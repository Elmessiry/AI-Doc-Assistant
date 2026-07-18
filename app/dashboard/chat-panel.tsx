"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import posthog from "posthog-js";
import { createClient } from "@/lib/supabase/client";

// UI-local message shape. Distinct from the server's ChatMessage (which also
// has a "system" role) — the UI only ever renders the user's questions and the
// assistant's replies.
type Message = { role: "user" | "assistant"; content: string };

type ChatPanelProps = {
  documentId: string;
  fileName: string;
  onClose: () => void;
};

export function ChatPanel({ documentId, fileName, onClose }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Earlier turns for this document, loaded once when the panel opens. Kept
  // separate from `error` (send failures) so a history hiccup doesn't read
  // like the chat itself is broken — and vice versa.
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const loadHistory = useCallback(async () => {
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const supabase = createClient();
      // supabase-js applies no timeout of its own; without one, a stalled
      // request keeps loadingHistory true — and the input disabled — until
      // the browser gives up on the connection, which can take minutes.
      const { data, error: fetchError } = await supabase
        .from("messages")
        .select("role, content")
        .eq("document_id", documentId)
        .order("created_at", { ascending: true })
        .abortSignal(AbortSignal.timeout(10_000));

      if (fetchError) {
        setHistoryError(fetchError.message);
        return;
      }
      // The DB check constraint limits role to 'user' | 'assistant', which is
      // exactly the UI's Message shape.
      setMessages((data as Message[]) ?? []);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : "Could not load the conversation.",
      );
    } finally {
      setLoadingHistory(false);
    }
  }, [documentId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadHistory();
  }, [loadHistory]);

  // Keep the newest message in view as tokens stream in. Reading a ref and
  // calling scrollIntoView (no setState) keeps this effect side-effect-only.
  const endRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Holds the current request so we can cancel it. Streaming answers can run
  // for seconds of paid generation, so an abandoned panel must abort — not
  // keep pulling tokens no one will read.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    // Abort any in-flight stream when the panel unmounts (including on close).
    return () => abortRef.current?.abort();
  }, []);

  // Move focus into the dialog when it opens so keyboard users start inside
  // it. The container itself (tabIndex={-1} below) is the target: it's
  // always a valid focus target on mount, even while history is still
  // loading and the input below is disabled={loadingHistory}.
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Once history finishes loading the input is no longer disabled — hand
  // focus off to it so keyboard users land where they'll actually type.
  useEffect(() => {
    if (!loadingHistory) inputRef.current?.focus();
  }, [loadingHistory]);

  // Modal keyboard behaviour: Escape closes; Tab is trapped within the dialog
  // so focus can't wander to the page behind it (what aria-modal promises).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      // Right after mount (or whenever nothing inside has focus yet) the
      // dialog container holds focus instead — it's excluded from
      // `focusable` by the [tabindex]:not([tabindex="-1"]) clause above, so
      // it won't match `first`/`last` below. Handle it explicitly so Tab
      // still lands inside the dialog instead of escaping to the page.
      if (active === dialogRef.current) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const question = input.trim();
    if (question.length === 0 || sending) return;

    setError(null);
    setInput("");
    // Push the question and an empty assistant bubble; the bubble fills in as
    // tokens arrive. Tracking the placeholder by position (last item) lets the
    // stream loop keep rewriting just that entry.
    setMessages((prev) => [
      ...prev,
      { role: "user", content: question },
      { role: "assistant", content: "" },
    ]);

    posthog.capture("chat_message_sent");

    setSending(true);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-POSTHOG-SESSION-ID": posthog.get_session_id() ?? "",
        },
        body: JSON.stringify({ message: question, documentId }),
        signal: ac.signal,
      });

      // On a non-2xx the route returns a JSON error, not a token stream — read
      // it as JSON so we surface the real reason (401, 404, 502, …).
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "The chat request failed.");
      }

      // Read the plain-text stream chunk by chunk, appending each piece to the
      // assistant bubble so the answer grows on screen as it's generated.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let answer = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        answer += decoder.decode(value, { stream: true });
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: answer };
          return next;
        });
      }

      if (answer.trim().length === 0) {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: "(No answer was returned.)",
          };
          return next;
        });
      }
    } catch (err) {
      // Aborted because the panel closed/unmounted — the component is gone,
      // so there's nothing to update. Just stop.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Something went wrong.");
      // Drop the empty placeholder so a failed turn doesn't leave a blank bubble.
      setMessages((prev) =>
        prev.filter(
          (msg, i) =>
            !(
              i === prev.length - 1 &&
              msg.role === "assistant" &&
              msg.content === ""
            ),
        ),
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Chat about ${fileName}`}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <div className="flex h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-200 bg-white shadow-xl sm:h-[80vh] dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between gap-4 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <p className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {fileName}
          </p>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close chat"
            className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            Close
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {loadingHistory && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Loading conversation…
            </p>
          )}

          {!loadingHistory && historyError && (
            <div className="flex items-center gap-3">
              <p role="alert" className="text-sm text-red-600 dark:text-red-400">
                Could not load earlier messages: {historyError}
              </p>
              <button
                type="button"
                onClick={() => void loadHistory()}
                // Reloading history swaps out the messages array; while an
                // answer is streaming, the stream loop rewrites the last
                // entry, so a mid-stream retry would corrupt the conversation.
                disabled={sending}
                className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Retry
              </button>
            </div>
          )}

          {!loadingHistory && !historyError && messages.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Ask a question about this document.
            </p>
          )}

          {messages.map((msg, i) => (
            <div
              key={i}
              className={
                msg.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-zinc-900 text-zinc-50 dark:bg-zinc-100 dark:text-zinc-900"
                    : "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                }`}
              >
                {msg.content || (sending ? "…" : "")}
              </div>
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {error && (
          <p
            role="alert"
            className="border-t border-zinc-200 px-4 py-2 text-xs text-red-600 dark:border-zinc-800 dark:text-red-400"
          >
            {error}
          </p>
        )}

        <form
          onSubmit={send}
          className="flex items-center gap-2 border-t border-zinc-200 p-3 dark:border-zinc-800"
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            disabled={sending || loadingHistory}
            className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-base text-zinc-900 outline-none placeholder:text-zinc-400 focus:border-zinc-500 disabled:opacity-50 sm:text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            type="submit"
            disabled={sending || input.trim().length === 0}
            className="shrink-0 rounded-lg bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-50 hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {sending ? "…" : "Send"}
          </button>
        </form>
      </div>
    </div>
  );
}
