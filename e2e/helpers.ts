import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { WebSocketLikeConstructor } from "@supabase/realtime-js";
import WebSocket from "ws";

// Fail loudly at import if a required var is missing, rather than producing a
// confusing auth error deep inside a test. See .env.test.local.example.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing env var ${name} — copy .env.test.local.example to .env.test.local and fill it in (or set it as a CI secret).`,
    );
  }
  return value;
}

export const SUPABASE_URL = required("NEXT_PUBLIC_SUPABASE_URL");
export const ANON_KEY = required("NEXT_PUBLIC_SUPABASE_ANON_KEY");
export const TEST_EMAIL = required("E2E_TEST_EMAIL");
export const TEST_PASSWORD = required("E2E_TEST_PASSWORD");
const realtime = { transport: WebSocket as unknown as WebSocketLikeConstructor };

// Service-role client bypasses RLS — used only in test setup/teardown to
// provision the test user and to clean up its data. Never shipped to the app.
export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, required("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime,
  });
}

// Ensure the dedicated test user exists with a known password. Magic-link users
// normally have no password, but the auth backend still accepts a password
// grant — giving the headless test a way in without an email round-trip.
// Idempotent: a second run hits "already registered", which we ignore.
export async function ensureTestUser(): Promise<void> {
  const admin = adminClient();
  const { error } = await admin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
    email_confirm: true,
  });
  if (error && !/already been registered|already exists/i.test(error.message)) {
    throw error;
  }
}

// Sign in with the test credentials to resolve the user's id (needed to scope
// cleanup). Uses the anon client, exactly as the app would.
export async function getTestUserId(): Promise<string> {
  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime,
  });
  const { data, error } = await anon.auth.signInWithPassword({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  });
  if (error || !data.user) throw error ?? new Error("Sign-in returned no user");
  return data.user.id;
}

// Remove everything the test user created so runs don't accumulate state (and
// so the per-user upload rate limit doesn't fill up across CI runs). Deleting
// the documents rows cascades to document_chunks and messages via FK.
export async function cleanupDocuments(userId: string): Promise<void> {
  const admin = adminClient();

  const { data: files } = await admin.storage.from("documents").list(userId, {
    limit: 1000,
  });
  if (files && files.length > 0) {
    await admin.storage
      .from("documents")
      .remove(files.map((f) => `${userId}/${f.name}`));
  }

  await admin.from("documents").delete().eq("user_id", userId);
  await admin.from("chat_requests").delete().eq("user_id", userId);
}
