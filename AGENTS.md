# AgentKnot contributor instructions

- Keep controller, worker, and provider as separate abstractions.
- Do not add a controller-vendor branch when the same behavior fits the Job API.
- Keep secrets in environment variables or external credential stores, never config fixtures.
- Pi RPC is strict LF-delimited JSONL; do not parse it with Node's `readline` API.
- Run `npm test` after changes.
- Add a deterministic test for each new adapter or state transition.
