import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdf-parse loads pdfjs-dist, which resolves a separate pdf.worker.mjs at
  // runtime. Bundling breaks that path ("Setting up fake worker failed").
  // Keep both as native node_modules requires so the worker resolves.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
