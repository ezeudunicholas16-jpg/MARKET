# Market Desk Engine Agent Notes

- Treat AI output as commentary only. Backend facts, provider data, and source evidence are the source of truth.
- Keep provider integrations behind interfaces in `packages/data-providers`.
- Public commentary must pass `packages/compliance` before publishing.
- Do not add live provider credentials to the repo. Add key names to `.env.example` only.
- Prefer focused tests around catalyst classification, confidence scoring, compliance, and API command behavior.
