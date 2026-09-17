# Instructions for AI coding agents

This is [mealie-nutrition-engine](https://github.com/Owndot/mealie-nutrition-engine) — a TypeScript/Node.js Fastify service that resolves nutrition for Mealie recipes from real food-composition records, with provenance.

Read `docs/ARCHITECTURE.md` before changing anything in `src/services/providers/`: the provider order and the hard gates encode measured production failures, and the tests pin real foods to real records.

## Commands

- `npm run dev` — Start dev server with hot reload via `tsx watch`
- `npm run build` — Compile TypeScript
- `npm run start` — Run compiled JS
- `npm run typecheck` — Type-check with `tsc --noEmit`
- `npm test` — Run vitest tests (run before/after changes)
- `npm run test:watch` — Run vitest in watch mode

## Code style

- TypeScript strict mode (check tsconfig for exact settings)
- Use ES module imports (`import`/`export`)
- Prefer `const` over `let` where possible
- No unnecessary comments in code
- Follow existing patterns in the codebase

## Workflow

- Always run `npm run typecheck` and `npm test` after making changes
- Keep commits focused and use conventional commit messages
- Run typecheck before committing to catch type errors
