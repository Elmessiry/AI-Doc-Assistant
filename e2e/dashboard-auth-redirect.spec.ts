import { test, expect } from "@playwright/test";

// Every other spec in this suite runs authenticated via the storage state
// auth.setup.ts seeds. This one deliberately runs without it, to exercise
// proxy.ts's redirect for a signed-out visitor. No Supabase writes or model
// calls involved, so it's cheap to run on every PR.
test.use({ storageState: { cookies: [], origins: [] } });

test("redirects an unauthenticated visitor from /dashboard to /login", async ({
  page,
}) => {
  await page.goto("/dashboard");
  await expect(page).toHaveURL(/\/login/);
});
