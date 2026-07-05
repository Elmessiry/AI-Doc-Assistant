// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
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
