import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

const REPO_URL = "https://github.com/Elmessiry/AI-Doc-Assistant";

export default async function Home() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const primary = user
    ? { href: "/dashboard", label: "Open dashboard" }
    : { href: "/login", label: "Sign in" };

  return (
    <main className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-2xl">
        <p
          className="rise font-mono text-xs tracking-[0.2em] text-zinc-500 uppercase dark:text-zinc-400"
          style={{ animationDelay: "0ms" }}
        >
          AI Document Assistant
        </p>

        <h1
          className="rise mt-5 text-4xl leading-[1.1] font-semibold tracking-tight text-zinc-900 sm:text-5xl dark:text-zinc-50"
          style={{ animationDelay: "60ms" }}
        >
          Chat with your documents.
          <br />
          <span className="text-zinc-500 dark:text-zinc-400">
            Answers grounded in the source.
          </span>
        </h1>

        <p
          className="rise mt-6 max-w-xl text-lg leading-relaxed text-zinc-600 dark:text-zinc-300"
          style={{ animationDelay: "120ms" }}
        >
          Upload a PDF, ask a question, and get an answer drawn only from that
          file. Your documents stay private — isolation is enforced by Postgres,
          not by application code.
        </p>

        <div
          className="rise mt-8 flex flex-wrap items-center gap-3"
          style={{ animationDelay: "180ms" }}
        >
          <Link
            href={primary.href}
            className="rounded-lg bg-zinc-900 px-5 py-2.5 text-sm font-medium text-zinc-50 transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:ring-offset-2 focus-visible:outline-none dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300 dark:focus-visible:ring-offset-black"
          >
            {primary.label}
          </Link>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-lg px-5 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:text-zinc-900 focus-visible:ring-2 focus-visible:ring-zinc-500 focus-visible:outline-none dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            View source →
          </a>
        </div>

        {/* Signature: the actual isolation model, in one policy. */}
        <figure
          className="rise mt-14 max-w-md"
          style={{ animationDelay: "260ms" }}
        >
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950">
            <pre className="font-mono text-[13px] leading-6 text-zinc-700 dark:text-zinc-300">
              <span className="text-zinc-400 dark:text-zinc-500">
                {"-- runs on every request, for every row\n"}
              </span>
              {'create policy "own documents" on documents\n'}
              {"  using ( "}
              <span className="text-emerald-600 dark:text-emerald-400">
                user_id = auth.uid()
              </span>
              {" );"}
            </pre>
          </div>
          <figcaption className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">
            The database decides who sees what — not the app.
          </figcaption>
        </figure>

        <p
          className="rise mt-14 font-mono text-xs text-zinc-400 dark:text-zinc-500"
          style={{ animationDelay: "320ms" }}
        >
          Next.js · Supabase · OpenRouter
        </p>
      </div>
    </main>
  );
}
