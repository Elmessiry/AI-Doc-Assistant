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
