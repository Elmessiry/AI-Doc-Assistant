import { createClient } from "@/lib/supabase/server";
import { captureServerEvent } from "@/lib/posthog-server";
import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        // Track by opaque user id only — no email or other PII to PostHog.
        captureServerEvent(request, user.id, "user_signed_in");
      }
      return NextResponse.redirect(`${origin}/dashboard`);
    }

    // The code exchange failed (expired or replayed code, provider misconfig).
    // Report it so the failure is traceable, and flag the redirect so /login
    // can tell a broken callback apart from a plain "not signed in yet".
    Sentry.captureException(error);
    return NextResponse.redirect(`${origin}/login?error=auth_callback_failed`);
  }

  return NextResponse.redirect(`${origin}/login`);
}
