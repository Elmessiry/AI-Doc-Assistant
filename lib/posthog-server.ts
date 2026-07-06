import { after } from "next/server";
import { PostHog } from "posthog-node";

let posthogClient: PostHog | null = null;

export function getPostHogClient() {
  if (!posthogClient) {
    posthogClient = new PostHog(
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!,
      {
        // posthog-node falls back to the US endpoint when host is undefined,
        // and this is an EU project — a deploy env missing the var would send
        // every server event to the wrong region, silently dropped.
        host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://eu.i.posthog.com",
        flushAt: 1,
        flushInterval: 0,
      },
    );
  }
  return posthogClient;
}

// Capture one server-side event and schedule its delivery for after the
// response is sent. capture() only queues the HTTP send — on serverless the
// instance freezes as soon as the response returns, dropping queued events.
// after() (backed by waitUntil on Vercel) keeps the instance alive until the
// flush settles. Must be called within request scope (route handlers or
// nested inside another after() callback).
export function captureServerEvent(
  req: Request,
  userId: string,
  event: string,
  properties: Record<string, unknown> = {},
) {
  const distinctId = req.headers.get("x-posthog-distinct-id") || userId;
  const sessionId = req.headers.get("x-posthog-session-id");

  const posthog = getPostHogClient();
  posthog.capture({
    distinctId,
    event,
    properties: {
      ...properties,
      ...(sessionId && { $session_id: sessionId }),
    },
  });
  after(() => posthog.flush());
}
