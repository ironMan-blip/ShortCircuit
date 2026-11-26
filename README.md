# ShortCircuit

An n8n AI crew that runs a tech YouTube Shorts channel: it researches a topic, writes and
fact-checks a script, renders a vertical video and publishes one Short a day.

The real goal is to **learn n8n multi-AI orchestration**. Native n8n nodes come first
(AI Agent, LLM chains, Guardrails, Send-and-Wait, Forms, Evaluations); code only where no
node fits. Full design: [`docs/PLAN.md`](docs/PLAN.md).

- Seven worker agents on local (Ollama) or free-tier models (Gemini, Groq), with fallback chains.
- A Master agent (Claude, via n8n's Anthropic Chat Model node) reviews and triages.
- The owner reviews through n8n forms mailed by Gmail, reachable only over Tailscale.
  Silence approves; a buffer of 3+ scheduled videos keeps the daily slot safe.

## Status

Milestone **M0** (infra) in progress. Done so far: Docker Compose stack, Postgres schema,
`.env` apply script with launchd agent and tests. Workflows, renderer and prompts come in
M1–M9 (PLAN §14).

## Layout

| Path | What |
|---|---|
| `docker-compose.yml` | Postgres 16, n8n, Kokoro TTS (renderer added at M4) |
| `db/init.sql` | Databases, roles and tables (PLAN §9) |
| `.env.example`, `renderer.env.example` | Settings templates; copy to `.env` / `renderer.env` |
| `scripts/apply-env.sh` | Validates `.env`, writes `state/.env.live`, recreates n8n safely |
| `launchd/com.shortcircuit.apply-env.plist` | Runs `apply-env.sh` on each `.env` save and every 60 s |
| `tests/apply-env.test.sh` | Tests for `apply-env.sh` with stub docker/osascript |
| `docs/PLAN.md` | The full plan and milestones |

`state/`, `data/`, `.env` and `renderer.env` are git-ignored. `state/` is host-only and never mounted.

## Class diagram

There is no class code yet: n8n workflows do the work. This diagram shows the main *things*
in the system, what each one holds, and how they connect. Tables come from `db/init.sql`;
agents and workflows come from PLAN §4 and §10.5.

```mermaid
classDiagram
    direction LR

    class Job {
        <<table jobs>>
        +int id  «shown as SC-0042»
        +text status  «where the job is now»
        +int round  «script rewrite count»
        +int attempts  «failed tries of this step, max 3»
        +timestamptz locked_at  «set while a worker holds it»
        +text last_error
        +text topic
        +jsonb brief  «Scout research»
        +jsonb script  «Writer output»
        +jsonb check_result  «Checker verdict»
        +jsonb plan  «Director edit plan»
        +text notes  «owner notes not yet applied»
        +timestamptz review_deadline  «auto-approve or drop time»
        +timestamptz review_sent_at
        +text review_url  «open form link»
        +timestamptz slot_at  «unique publish time»
        +date slot_date  «unique: one video per day»
        +timestamptz render_started_at
        +text triage_from  «status it failed in»
        +timestamptz triage_at  «6 h limit starts»
        +int master_rounds  «Master fixes, max 2»
        +jsonb providers  «model used per agent»
        +jsonb outbox  «mail not yet sent»
        +text drive_file_id
        +text drive_link
        +text youtube_id
        +text channel_id
        +text gmail_thread_id
        +text gmail_message_id
        +timestamptz created_at
        +timestamptz updated_at
    }

    class JobStatus {
        <<enumeration>>
        new
        script_review
        needs_human
        revising
        script_approved
        video_review
        video_editing
        approved
        awaiting_upload
        scheduled
        live
        done
        triage
        rejected
        cancelled
        failed
    }

    class Review {
        <<table reviews>>
        +text execution_id  «PK: one decision per form»
        +int job_id  «FK jobs.id»
        +text kind  «script | video | needs_human | cancel»
        +text decision  «approve | approve_changes | revise | reject | timeout | cancel»
        +text notes  «PII removed by Guardrails»
        +timestamptz answered_at
    }

    class Metric {
        <<table metrics>>
        +int job_id  «PK part, FK jobs.id»
        +int age_h  «PK part: 24, 48 or 168»
        +int views
        +int likes
        +int comments
        +timestamptz taken_at
    }

    class MasterLog {
        <<table master_log>>
        +int id  «PK»
        +int job_id  «FK jobs.id, null for daily or weekly work»
        +text task  «which Master job ran»
        +jsonb result  «verdict, action, or skipped reason»
        +jsonb usage  «tokens and web searches, for cost»
        +timestamptz created_at
    }

    class Schedule {
        <<table schedule>>
        +int dow  «PK: 0 = Sunday … 6»
        +time publish_time
        +text reason  «why the Scheduler chose it»
        +timestamptz updated_at
    }

    class ConfigSeen {
        <<table config_seen>>
        +text key  «PK: owner email, channel handle …»
        +text value  «last value seen»
        +timestamptz changed_at
    }

    class Alert {
        <<table alerts>>
        +text key  «PK: one alert per problem»
        +timestamptz last_sent_at  «max one per day»
    }

    class WorkerAgent {
        <<LLM chain, no tools>>
        +text name
        +text prompt_file  «prompts/name.md»
        +json output_schema  «prompts/name.schema.json»
        +list model_chain  «first valid JSON wins»
        +run(input) json  «always through sc.llm»
    }

    class Scout {
        +pickTopic() topic
        +writeBrief() brief
    }
    class Writer {
        +writeScript(brief) script
    }
    class Checker {
        +check(script) check_result  «other model family than Writer»
    }
    class Editor {
        +applyNotes(script, notes) script  «never Gemini»
    }
    class Director {
        +makePlan(script) plan
    }
    class Cutter {
        +applyNotes(plan, notes) plan  «never Gemini»
    }
    class Scheduler {
        +choosePublishTimes(metrics) schedule
    }

    class Master {
        <<Claude>>
        +review(output) verdict  «judge, via sc.ask_master»
        +triage(job)  «AI Agent with tools, via sc.master»
        +dailyReview()  «21:00 every day»
        +diagnose()  «weekly crew check»
    }

    class MasterTool {
        <<sub-workflow sc.tool.*>>
        +get_job()  «read»
        +crew_stats()  «read»
        +list_stuck()  «read»
        +retry_job()  «back to triage_from»
        +redo_job()  «revising or video_editing»
        +fail_job()  «failed + alert»
        +reject_job()  «owner must approve»
    }

    class Workflow {
        <<n8n workflow>>
        +text name  «sc.produce, sc.create, sc.review …»
        +text trigger  «timer, form or called»
        +text claims_status  «status it picks up»
        +claim() Job  «FOR UPDATE SKIP LOCKED»
        +moveTo(status)  «guarded status change»
    }

    class Owner {
        <<person>>
        +answerForm(job) Review  «over Tailscale only»
        +silence()  «approves after 12 h»
    }

    WorkerAgent <|-- Scout
    WorkerAgent <|-- Writer
    WorkerAgent <|-- Checker
    WorkerAgent <|-- Editor
    WorkerAgent <|-- Director
    WorkerAgent <|-- Cutter
    WorkerAgent <|-- Scheduler

    Job --> JobStatus : status is one of
    Job "1" *-- "0..*" Review : owner decisions
    Job "1" *-- "0..3" Metric : views after going live
    Job "1" o-- "0..*" MasterLog : Master decisions
    Workflow "1" --> "0..1" Job : claims and moves
    Workflow ..> WorkerAgent : runs
    Workflow ..> Master : asks
    Workflow ..> Alert : sends at most daily
    Workflow ..> ConfigSeen : notices changes
    Master "1" --> "7" MasterTool : may call
    MasterTool --> Job : guarded SQL
    Master ..> MasterLog : writes every decision
    Scheduler ..> Metric : reads
    Scheduler ..> Schedule : writes
    Owner ..> Review : creates by answering
```

How to read it:
- **Box** = one thing. `<<table x>>` boxes are real Postgres tables; the rest are roles played by n8n workflows.
- **`+field type «note»`** = a column or property, its type, and what it means.
- **Hollow triangle arrow** = "is a kind of": every worker agent shares the same shape.
- **Filled diamond** = "owns": the row belongs to one job. **Hollow diamond** = "links to", may be empty.
- **Solid arrow** = "points to or changes". **Dashed arrow** = "uses".
- **`"1" … "0..*"`** = how many: one job has zero or more reviews.

## Setup (macOS)

```sh
cp .env.example .env              # fill in; secrets: openssl rand -hex 32 / 24
cp renderer.env.example renderer.env
bash scripts/apply-env.sh         # writes state/.env.live
docker compose up -d

# auto-apply future .env saves
sed "s|__ROOT__|$PWD|g" launchd/com.shortcircuit.apply-env.plist \
  > ~/Library/LaunchAgents/com.shortcircuit.apply-env.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.shortcircuit.apply-env.plist
```

n8n listens on `127.0.0.1:5678` only; expose it to your tailnet with `tailscale serve`
(never `funnel`). `N8N_ENCRYPTION_KEY` and the Postgres passwords cannot be changed by a
reload; back up the key.

## Tests

```sh
bash tests/apply-env.test.sh
```
