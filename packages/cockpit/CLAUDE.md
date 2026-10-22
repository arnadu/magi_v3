# cockpit

The operator UI: a Vite + React single-page app, built by CI into
`packages/control-plane/public/` (gitignored) and served by the control plane. Loaded on top of
the root `CLAUDE.md` when working in this package.

```bash
npm run build -w packages/cockpit     # writes ../control-plane/public
```

- Server calls go through `src/api/` (one module per domain over `http.ts`'s `request`/`api`,
  which map 401/403 to `AuthError`/`ForbiddenError`); `src/data.ts` is a re-export barrel.
- Shared API types come from `@magi/agent-config` as type-only imports (erased by Vite), as
  `llm-call-types.ts` does.
- Coverage counts the pure logic modules only — not components (`.tsx`), hooks, `src/api/` or
  `auth.ts`, which need a DOM, Firebase or a server. Pull testable logic out of components into
  a plain `.ts` module.
- Authentication is an HttpOnly session cookie set by `POST /api/auth/session`; no credential is
  stored in `localStorage`/`sessionStorage`. Rendered Markdown goes through `markdown.ts`
  (escaping and URL-scheme allow-list, F-049) — never `dangerouslySetInnerHTML` on raw text.
