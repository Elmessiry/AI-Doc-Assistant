// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "https://7ec64d984be74332e8f63c1602238af8@o4511660181356544.ingest.de.sentry.io/4511683077996624",

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,
  // Enable logs to be sent to Sentry
  enableLogs: true,

  dataCollection: {
    // Don't attach user identity or request/response bodies to events —
    // bodies here contain chat messages and document text.
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection
    userInfo: false,
    httpBodies: [],
  },
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

import posthog from "posthog-js";

posthog.init(process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN!, {
  api_host: "/ingest",
  ui_host: "https://eu.posthog.com",
  defaults: "2026-01-30",
  // Sentry owns error tracking; PostHog only measures behaviour.
  capture_exceptions: false,
  debug: process.env.NODE_ENV === "development",
});
