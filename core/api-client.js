// core/api-client.js — owned by neither engine. core/ never imports from engines/.
// Alpaca auth + transport only (keys, headers, the bare fetch wrapper).
// The shared rate-limit queue is Phase 0.5 — not built here; see
// docs/warrior-engine-spec-v2.md Phase 0.5 before adding an enqueue() layer.
// Phase 0 scaffold — content moves here from app.js in a later commit.
