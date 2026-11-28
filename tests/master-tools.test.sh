#!/bin/bash
# Runs the Master's action-tool SQL (workflows/sc.tool.*.json) in a rolled-back transaction:
# each guard refuses what PLAN §4.8 says it must, and a good call acts once.
# usage: PSQL="docker exec -i <postgres container> psql -U postgres -d shortcircuit" bash tests/master-tools.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=${PSQL:?set PSQL to a psql command for a database with db/init.sql applied}
prep() { echo "PREPARE $1(text, text, text, text) AS $(jq -r '.nodes[] | select(.name=="Act") | .parameters.query' workflows/sc.tool.$1.json);"; }
{
echo "BEGIN;"
for t in retry_job redo_job fail_job reject_job; do prep $t; done
cat <<'SQL'
DO $$ DECLARE a int; b int; c int; d int; r text; bad int := 0;
BEGIN
  INSERT INTO jobs (status, triage_from, triage_at, script) VALUES ('triage', 'revising', now(), '{"title":"x"}') RETURNING id INTO a;
  INSERT INTO jobs (status, triage_from, master_rounds) VALUES ('triage', 'new', 2) RETURNING id INTO b;
  INSERT INTO jobs (status, updated_at) VALUES ('script_approved', now() - interval '2 days') RETURNING id INTO c;
  INSERT INTO jobs (status) VALUES ('script_approved') RETURNING id INTO d;
  -- triage: the job id is fixed; another job is refused
  EXECUTE format('EXECUTE reject_job(%L, %L, %L, %L)', 'SC-' || d, 'triage', a::text, 'x') INTO r;
  IF r NOT LIKE 'refused: not the job in triage%' THEN RAISE WARNING 'FAIL other job: %', r; bad := bad + 1; END IF;
  EXECUTE format('EXECUTE retry_job(%L, %L, %L, %L)', 'SC-' || b, 'triage', b::text, 'x') INTO r;
  IF r <> 'refused: master_rounds is 2' THEN RAISE WARNING 'FAIL rounds: %', r; bad := bad + 1; END IF;
  EXECUTE format('EXECUTE redo_job(%L, %L, %L, %L)', 'SC-' || a, 'triage', a::text, 'shorter hook') INTO r;
  IF r NOT LIKE 'done:%revising' THEN RAISE WARNING 'FAIL redo: %', r; bad := bad + 1; END IF;
  IF (SELECT master_rounds FROM jobs WHERE id = a) <> 1 OR (SELECT notes FROM jobs WHERE id = a) <> 'From the Master: shorter hook' THEN RAISE WARNING 'FAIL redo row'; bad := bad + 1; END IF;
  -- daily: only jobs stuck > 24 h
  EXECUTE format('EXECUTE retry_job(%L, %L, %L, %L)', 'SC-' || d, 'daily', '0', 'x') INTO r;
  IF r NOT LIKE 'refused: not stuck%' THEN RAISE WARNING 'FAIL not stuck: %', r; bad := bad + 1; END IF;
  EXECUTE format('EXECUTE retry_job(%L, %L, %L, %L)', 'SC-' || c, 'daily', '0', 'x') INTO r;
  IF r NOT LIKE 'done:%script_approved' THEN RAISE WARNING 'FAIL stuck retry: %', r; bad := bad + 1; END IF;
  -- failed jobs and unknown ids are refused
  UPDATE jobs SET status = 'failed', master_rounds = 0 WHERE id = b;
  EXECUTE format('EXECUTE fail_job(%L, %L, %L, %L)', 'SC-' || b, 'triage', b::text, 'x') INTO r;
  IF r <> 'refused: job is failed' THEN RAISE WARNING 'FAIL failed job: %', r; bad := bad + 1; END IF;
  EXECUTE format('EXECUTE fail_job(%L, %L, %L, %L)', 'SC-999999', 'triage', '999999', 'x') INTO r;
  IF r <> 'refused: no such job' THEN RAISE WARNING 'FAIL unknown: %', r; bad := bad + 1; END IF;
  IF (SELECT count(*) FROM master_log WHERE task LIKE 'tool:%') < 6 THEN RAISE WARNING 'FAIL tool calls not logged'; bad := bad + 1; END IF;
  IF bad > 0 THEN RAISE EXCEPTION '% tool case(s) failed', bad; END IF;
  RAISE NOTICE 'all tool cases passed';
END $$;
ROLLBACK;
SQL
} | $PSQL -v ON_ERROR_STOP=1 -q 2>&1 | grep -E "NOTICE|WARNING|ERROR"; exit ${PIPESTATUS[1]}
