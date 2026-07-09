> Onboarding briefing for coding agents and contributors. `AGENTS.md` is the canonical technical briefing; this file imports it, so edit `AGENTS.md` only. Production hosting and operations specifics are intentionally out of scope and maintained privately.

# CLAUDE.md (cairn-sdk)

The full technical briefing for this repo lives in `AGENTS.md` (the dApp aggregator SDK: facade namespaces, invariants, dev/test/publish, gotchas, cross-repo map). It is the single source of truth; read it first and keep both files in sync by editing `AGENTS.md`.

@AGENTS.md

## Operating notes

- **This is the public dApp-facing SDK; third parties build on its contract.** Single most important red line: never over-claim trust. `verified-inclusion` requires a PoW-verified header; `cairn.names.*` / `registry.resolveName()` are server-trusted display reads and must never be wired straight into a payment target. Connection never pre-approves signatures.
- `DEFAULT_SPV_CHECKPOINT` must stay byte-identical to cairn's swapguard anchor (test-enforced); `SDK_VERSION` in `errors.ts` bumps with package.json; csd-* deps exact-pinned. Package manager is pnpm.
- Consensus values come from the published csd-*/cairnx-core packages, never re-declared locally. Security fixes must not regress UX on legitimate hot paths.
- No em dashes in user-facing docs; keep prose concrete, no filler. Version bumps, tags, and npm publishes are maintainer actions only.
