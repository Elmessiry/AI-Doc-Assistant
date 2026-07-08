import { test as setup, expect } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";
import {
  SUPABASE_URL,
  ANON_KEY,
  TEST_EMAIL,
  TEST_PASSWORD,
  ensureTestUser,
} from "./helpers";

const authFile = "e2e/.auth/user.json";

// Runs once before the test project. Signs the test user in and saves the
// resulting session cookies as Playwright storage state, so every test starts
// already authenticated — no magic-link email to click.
setup("authenticate", async ({ context, baseURL }) => {
  await ensureTestUser();

  // Rather than hand-encode Supabase's cookie format (which is versioned and
  // chunked), let @supabase/ssr encode it for us: a server client with a
  // capturing `setAll` writes the exact cookies it wants on sign-in, and we
  // collect them.
  const captured: { name: string; value: string }[] = [];
  const client = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll: () => [],
      setAll: (cookies) => {
        for (const { name, value } of cookies) captured.push({ name, value });
      },
    },
  });

  const { error } = await client.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error) throw error;
  expect(captured.length).toBeGreaterThan(0);

  await context.addCookies(
    captured.map((c) => ({
      name: c.name,
      value: c.value,
      url: baseURL!,
      sameSite: "Lax" as const,
    })),
  );

  await context.storageState({ path: authFile });
});
