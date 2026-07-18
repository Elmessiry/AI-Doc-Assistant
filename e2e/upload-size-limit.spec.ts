import { test, expect } from "@playwright/test";

// The 1 MB size check in upload-zone.tsx runs client-side before any file
// content is read or any network request is made, so this needs no live
// model call and no valid PDF — an in-memory buffer that's merely the right
// size is enough to trip it.
test("rejects a file over the 1 MB client-side limit before uploading", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(
    page.getByRole("button", { name: "Upload a document" }),
  ).toBeVisible();

  let storageRequests = 0;
  page.on("request", (req) => {
    if (req.url().includes("/storage/v1/object/")) storageRequests++;
  });

  await page.locator('input[type="file"]').setInputFiles({
    name: "too-big.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.alloc(1024 * 1024 + 1),
  });

  // Next.js's own route announcer also has role="alert", so scope by text
  // rather than by role alone to avoid an ambiguous match.
  await expect(
    page.getByText("File is too large — the maximum size is 1 MB."),
  ).toBeVisible();

  // The size check returns before setUploading(true), so the zone never
  // leaves its idle state and no bytes are sent to storage.
  await expect(
    page.getByText("Drop a file here, or click to browse"),
  ).toBeVisible();
  expect(storageRequests).toBe(0);
});
