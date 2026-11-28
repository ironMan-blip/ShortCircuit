-- Runs once, when the Postgres volume is first created (docs/PLAN.md §9, §10.2).
-- The n8n database is made by the image (POSTGRES_DB=n8n); this adds the app database,
-- its tables, the sc_app role used by the `SC Postgres` credential and the n8n_app role n8n
-- itself logs in as (owner of the n8n database, not a superuser).
\set ON_ERROR_STOP on
\getenv app_pw POSTGRES_APP_PASSWORD
\getenv n8n_pw POSTGRES_N8N_PASSWORD
\if :{?app_pw}
  SELECT :'app_pw' = '' AS app_pw_empty \gset
\else
  \set app_pw_empty true
\endif
\if :app_pw_empty
  DO $$ BEGIN RAISE EXCEPTION 'POSTGRES_APP_PASSWORD is not set'; END $$;
\endif
\if :{?n8n_pw}
  SELECT :'n8n_pw' = '' AS n8n_pw_empty \gset
\else
  \set n8n_pw_empty true
\endif
\if :n8n_pw_empty
  DO $$ BEGIN RAISE EXCEPTION 'POSTGRES_N8N_PASSWORD is not set'; END $$;
\endif

-- Not a superuser and no pg_* file/program roles, so no COPY ... PROGRAM and no file access.
CREATE ROLE sc_app LOGIN PASSWORD :'app_pw';
CREATE ROLE n8n_app LOGIN PASSWORD :'n8n_pw';
CREATE DATABASE shortcircuit;
-- The owner may connect and create tables in its public schema (pg_database_owner, PG 15+).
ALTER DATABASE n8n OWNER TO n8n_app;

-- sc_app may connect to its own database only.
REVOKE ALL ON DATABASE postgres, n8n, shortcircuit FROM PUBLIC;
GRANT CONNECT ON DATABASE shortcircuit TO sc_app;

\connect shortcircuit

CREATE TABLE jobs (
  id               serial PRIMARY KEY,           -- shown as SC-0042
  status           text NOT NULL DEFAULT 'new',
  round            int  NOT NULL DEFAULT 0,      -- script revision rounds
  attempts         int  NOT NULL DEFAULT 0,      -- failed tries of the current step
  locked_at        timestamptz,                  -- set while a worker holds the job
  last_error       text,
  topic            text,
  brief            jsonb,
  script           jsonb,
  check_result     jsonb,
  plan             jsonb,
  notes            text,                         -- owner notes waiting to be applied
  edit_then        text,                         -- after video_editing: 'approve' (approved with changes) or 'review'
  review_deadline  timestamptz,                  -- auto-approve / drop time (also the form's wait limit)
  review_sent_at   timestamptz,                  -- set by sc.review when its form mail went out
  review_url       text,                         -- the open form ($execution.resumeFormUrl)
  slot_at          timestamptz UNIQUE,
  slot_date        date UNIQUE,                  -- slot day in TZ: one video per day
  render_started_at timestamptz,                 -- set while the renderer runs (§10.4)
  triage_from      text,                         -- status the job failed in
  triage_at        timestamptz,                  -- when it entered triage (6 h timeout)
  master_rounds    int  NOT NULL DEFAULT 0,      -- Master interventions (max 2)
  providers        jsonb NOT NULL DEFAULT '{}',  -- provider used per agent, e.g. {"writer": "gemini"}
  outbox           jsonb,                        -- {subject, html} of a plain mail not yet sent (§10.3)
  drive_file_id    text,
  drive_link       text,
  youtube_id       text,
  channel_id       text,                         -- channel the video was uploaded to
  gmail_thread_id  text,
  gmail_message_id text,                         -- last bot mail sent by sc.mail (audit)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON jobs (status);

CREATE TABLE reviews (                           -- every owner decision, kept for audit
  execution_id text PRIMARY KEY,                 -- the sc.review run: one decision per form
  job_id int REFERENCES jobs(id),
  kind text,                                     -- script | video | needs_human | cancel
  decision text,                                 -- approve | approve_changes | revise | reject | timeout | cancel
  notes text,                                    -- after the Guardrails PII sanitiser
  answered_at timestamptz DEFAULT now()
);

CREATE TABLE config_seen (                       -- last OWNER_EMAIL / Drive-shared address / CHANNEL_HANDLE / channel id
  key text PRIMARY KEY, value text, changed_at timestamptz DEFAULT now()
);

CREATE TABLE alerts (                            -- one alert per problem per day
  key text PRIMARY KEY, last_sent_at timestamptz
);

CREATE TABLE metrics (                           -- Scheduler input, saved by sc.livecheck
  job_id int REFERENCES jobs(id),
  age_h  int,                                    -- 24, 48 or 168 h after going live
  views int, likes int, comments int,
  taken_at timestamptz DEFAULT now(),
  PRIMARY KEY (job_id, age_h)
);

CREATE TABLE schedule (                          -- publish time per weekday, from the Scheduler
  dow int PRIMARY KEY CHECK (dow BETWEEN 0 AND 6),  -- 0 = Sunday
  publish_time time NOT NULL,
  reason text, updated_at timestamptz DEFAULT now()
);

CREATE TABLE master_log (                        -- every Master decision, for the brief and audit
  id serial PRIMARY KEY,
  job_id int REFERENCES jobs(id),                -- NULL for daily review and diagnosis
  task text, result jsonb,                       -- verdict / action, or {skipped: reason}
  usage jsonb,                                   -- tokens + web searches, for the cost line
  created_at timestamptz DEFAULT now()
);

-- Rows only: no DDL, no ownership, no TRUNCATE.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO sc_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO sc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sc_app;
