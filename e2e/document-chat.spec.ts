import { test, expect } from "@playwright/test";
import path from "node:path";
import { cleanupDocuments, getTestUserId } from "./helpers";

const fixturePdf = path.join(__dirname, "fixtures", "sample.pdf");

// Start and end from a clean slate: a failed prior run could leave documents
// behind, which would make the "Searchable" / "Chat about sample.pdf" locators
// ambiguous and inflate the upload rate-limit counter.
test.beforeAll(async () => {
  await cleanupDocuments(await getTestUserId());
});
test.afterAll(async () => {
  await cleanupDocuments(await getTestUserId());
});

test("upload a PDF, process it, and get a grounded chat answer", async ({
  page,
}) => {
  // Authenticated via seeded storage state, so /dashboard should load — not
  // redirect to /login.
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: "Upload a document" })).toBeVisible();

  // Upload the fixture. The file input is visually hidden but still settable.
  await page.locator('input[type="file"]').setInputFiles(fixturePdf);

  // Extraction runs server-side and the list polls for status; wait for the
  // document to become searchable.
  await expect(page.getByText("Searchable")).toBeVisible({ timeout: 30_000 });

  // Open this document's chat (the small button, whose accessible name is the
  // aria-label "Chat about <file>").
  await page.getByRole("button", { name: "Chat about sample.pdf" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Ask something only answerable from the document's text. A grounded answer
  // must echo the sentinel; a model answering from general knowledge could not.
  await dialog
    .getByPlaceholder("Ask a question…")
    .fill("What is the exact sentinel code written in this document?");
  await dialog.getByRole("button", { name: "Send" }).click();

  // The assistant bubble (left-aligned) fills in as the answer streams.
  const assistant = dialog.locator(".justify-start").last();
  await expect(assistant).toContainText("ZEBRA-42931", { timeout: 30_000 });
});
