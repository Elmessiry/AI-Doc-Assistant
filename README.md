# AI Document Assistant

**Upload a document, ask questions about it.** A multi-tenant app where user data isolation is enforced by Postgres Row Level Security — not by application code.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)
![Supabase](https://img.shields.io/badge/Supabase-3FCF8E?logo=supabase&logoColor=white)

> 🚧 Actively being built. Auth and the secure document store are done; document processing and chat are next.

## How it works

The frontend never filters by user — it asks for "all documents" and the database returns only the caller's, because every request carries the user's JWT and the RLS policies key on `auth.uid()`. Files live in a private Storage bucket under a `<user-id>/` path, so one user can't reach another's files even with a direct API call.

**Stack:** Next.js (App Router) + TypeScript · Supabase (Postgres, Auth, Storage, RLS) · OpenRouter _(chat, coming)_ · Vercel _(coming)_.

## Getting started

```bash
npm install
```

Create `.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<your-project>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your-anon-key>
```

In Supabase: enable the Email (magic-link) provider, create a **private** bucket named `documents`, and create a `documents` table with RLS. Then:

```bash
npm run dev
```

## Roadmap

- [x] Magic-link auth + protected dashboard
- [x] Private uploads with row-level security and per-user rate limiting
- [ ] PDF parsing + chunking
- [ ] Chat with retrieval (RAG)
- [ ] Deploy, custom domain, tests
