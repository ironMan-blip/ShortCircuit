# Build notes: M1–M9 in code (2026-11-28)

The workflows were built from code (`scripts/wfgen/`) and run on a throwaway stack with the
pinned n8n 2.49.7, Postgres, Kokoro, the renderer and a local `qwen3:1.7b` in Ollama. No real
Google, Groq, Gemini or Anthropic credentials were used, so every external call either ran for
real (news sources, the renderer, Ollama) or was checked on its failure path.

## Checked end to end

- `sc.llm`: valid JSON from Ollama; fallback past a provider with a broken key; an
  excluded provider leaves an empty chain → error, as designed.
- `sc.create`: all source fetches, GitHub Trending parsing, page fetches **through the
  renderer's checking proxy**, Guardrails, the url check (it kept refusing the small model's
  HN-only picks: correct), Writer rules, Master skipped when down, finish, review start.
- `sc.render`: a real 36 s video (Kokoro voice, captions, music), Ollama unloaded first, a
  planted screenshot url turned into a card, slot assigned ≥ 48 h ahead, local copy deleted.
- `sc.review` (with a Wait-node form standing in for Gmail): the waiting execution, the form
  answer, Guardrails removing a phone number and an e-mail from the notes, the guarded update.
- `sc.cancel`: Basic Auth, the pre-filled job id, the cancel and its ending page.
- `sc.master` and `sc.master.daily` with the Master down: job released, logged as skipped.
- `sc.produce`, `sc.schedule` (cold-start rotation), `sc.timeouts` (to triage), `sc.publish`
  (manual pack; the outbox stays when Gmail fails), `sc.livecheck` and `sc.config` stop on a
  YouTube or Drive error, `sc.housekeeping`.
- SQL of every review decision, the Master's tool guards and slot assignment:
  `tests/review-apply.test.sh`, `tests/master-tools.test.sh`, `tests/slots.test.sh`.

## n8n behaviour worth knowing (each one was a bug first)

- A Postgres *Execute Query* that returns no rows still outputs one `{success: true}` item.
  Without an If after a claim, a worker with nothing to do runs its whole step.
- The Code node sandbox has no `URL` class.
- A Basic LLM Chain with *On Error: continue (error output)* can still put `{error}` on its
  success output; an AI Agent puts a sub-node error on its main output.
- Two data-modifying statements on the same row in one SQL statement: the second is ignored.
- `n8n execute` (CLI) runs a workflow but kills sub-workflows started with *wait* off.
- `n8n publish:workflow` reaches the running server a moment later; a workflow that calls an
  unpublished sub-workflow cannot be published.
- Gmail *Send and Wait* passes its input through on a time-out (no `data`); a Wait node form
  outputs nothing on a time-out.
- A Form Trigger with *Respond: Using 'Respond to Webhook' Node* refuses to start without one;
  Form Ending nodes work with the default.
- An AI Agent tool's name is its node name.

## Not checked (needs the owner's accounts)

Gmail send and send-and-wait, Drive, YouTube, Gemini, Groq, the Anthropic node and the raw
Messages API call, Data Tables and Evaluations (need the community-edition registration), and
the Model Selector / built-in fallback comparison of the M1 exercise.
