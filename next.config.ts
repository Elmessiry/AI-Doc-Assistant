import { withSentryConfig } from "@sentry/nextjs";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads pdfjs-dist, which resolves a separate pdf.worker.mjs at
  // runtime. Bundling breaks that path ("Setting up fake worker failed").
  // Keep both as native node_modules requires so the worker resolves.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // pdfjs loads several things through dynamic requires/imports that @vercel/nft
  // can't follow statically, so they get dropped from the serverless bundle and
  // fail only on Vercel (a full local node_modules hides all of this):
  //   - @napi-rs/canvas: pdfjs's DOMMatrix/ImageData/Path2D polyfill, required in
  //     a try/catch. Missing → fatal "ReferenceError: DOMMatrix is not defined"
  //     that the external-module loader throws at function init.
  //   - pdf.worker.mjs: the fake (main-thread) worker imports it by relative
  //     path. Missing → "Setting up fake worker failed" → getText() throws → 422.
  //   - standard_fonts / cmaps: font metrics and CJK maps loaded at parse time.
  // Force all of them into this route's trace.
  outputFileTracingIncludes: {
    "/api/process-document": [
      "./node_modules/@napi-rs/**/*",
      "./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
      "./node_modules/pdfjs-dist/standard_fonts/**/*",
      "./node_modules/pdfjs-dist/cmaps/**/*",
    ],
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  skipTrailingSlashRedirect: true,
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  org: "messi-vs",

  project: "javascript-nextjs",

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
});
