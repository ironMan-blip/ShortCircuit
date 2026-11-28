#!/bin/bash
# Runs sc.review's Apply statement (from workflows/sc.review.json) against every state × decision
# of PLAN §10.6 in a scratch Postgres database, inside one rolled-back transaction.
# usage: PSQL="docker exec -i <postgres container> psql -U postgres -d shortcircuit" bash tests/review-apply.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=${PSQL:?set PSQL to a psql command for a database with db/init.sql applied}
q=$(jq -r '.nodes[] | select(.name=="Apply") | .parameters.query' workflows/sc.review.json)
{
echo "BEGIN;"
echo "PREPARE apply(int, text, text, text, text, text) AS $q;"
cat <<'SQL'
CREATE TEMP TABLE cases (state text, decision text, want text);
INSERT INTO cases VALUES
 ('script_review','approve','script_approved'), ('script_review','approve_changes','script_approved'), ('script_review','revise','revising'),
 ('script_review','reject','rejected'), ('script_review','timeout','script_approved'),
 ('needs_human','approve','script_approved'), ('needs_human','approve_changes','script_approved'), ('needs_human','revise','revising'),
 ('needs_human','reject','rejected'), ('needs_human','timeout','rejected'),
 ('video_review','approve','approved'), ('video_review','approve_changes','video_editing'), ('video_review','revise','video_editing'),
 ('video_review','reject','rejected'), ('video_review','timeout','approved');
DO $$ DECLARE c record; j int; r record; bad int := 0; BEGIN
  FOR c IN SELECT * FROM cases LOOP
    INSERT INTO jobs (status, review_url, slot_at, slot_date) VALUES (c.state, 'form-' || c.state || c.decision,
      CASE WHEN c.state = 'video_review' THEN now() + interval '5 days' + (random() * interval '30 days') END,
      CASE WHEN c.state = 'video_review' THEN current_date + 100 + (SELECT count(*) FROM jobs)::int END) RETURNING id INTO j;
    EXECUTE format('EXECUTE apply(%s, %L, %L, %L, %L, %L)', j, 'form-' || c.state || c.decision, 'exec-' || j, c.decision, 'k', 'some notes');
    SELECT status, notes, slot_date, edit_then, review_url FROM jobs WHERE id = j INTO r;
    IF r.status IS DISTINCT FROM c.want OR r.review_url IS NOT NULL
       OR (c.want = 'rejected' AND r.slot_date IS NOT NULL)
       OR (c.decision IN ('approve_changes','revise') AND r.notes IS DISTINCT FROM 'some notes')
       OR (c.want = 'video_editing' AND r.edit_then IS DISTINCT FROM CASE c.decision WHEN 'approve_changes' THEN 'approve' ELSE 'review' END) THEN
      RAISE WARNING 'FAIL % × %: got % (notes %, slot %, edit_then %)', c.state, c.decision, r.status, r.notes, r.slot_date, r.edit_then; bad := bad + 1;
    END IF;
  END LOOP;
  -- an old (replaced) form changes nothing; the same form twice applies once
  INSERT INTO jobs (status, review_url) VALUES ('script_review', 'new-form') RETURNING id INTO j;
  EXECUTE format('EXECUTE apply(%s, %L, %L, %L, %L, %L)', j, 'old-form', 'exec-old', 'reject', 'script', '');
  IF (SELECT status FROM jobs WHERE id = j) <> 'script_review' THEN RAISE WARNING 'FAIL old form applied'; bad := bad + 1; END IF;
  EXECUTE format('EXECUTE apply(%s, %L, %L, %L, %L, %L)', j, 'new-form', 'exec-new', 'approve', 'script', '');
  UPDATE jobs SET status = 'script_review', review_url = 'new-form' WHERE id = j;
  EXECUTE format('EXECUTE apply(%s, %L, %L, %L, %L, %L)', j, 'new-form', 'exec-new', 'reject', 'script', '');
  IF (SELECT status FROM jobs WHERE id = j) <> 'script_review' THEN RAISE WARNING 'FAIL the same form applied twice'; bad := bad + 1; END IF;
  -- a cancelled job is not moved by its waiting review
  INSERT INTO jobs (status, review_url) VALUES ('cancelled', NULL) RETURNING id INTO j;
  EXECUTE format('EXECUTE apply(%s, %L, %L, %L, %L, %L)', j, 'x', 'exec-c', 'approve', 'script', '');
  IF (SELECT status FROM jobs WHERE id = j) <> 'cancelled' THEN RAISE WARNING 'FAIL cancelled job moved'; bad := bad + 1; END IF;
  IF bad > 0 THEN RAISE EXCEPTION '% review case(s) failed', bad; END IF;
  RAISE NOTICE 'all review cases passed';
END $$;
ROLLBACK;
SQL
} | $PSQL -v ON_ERROR_STOP=1 -q 2>&1 | grep -E "NOTICE|WARNING|ERROR" ; exit ${PIPESTATUS[1]}
