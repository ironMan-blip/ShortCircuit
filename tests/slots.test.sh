#!/bin/bash
# Runs sc.render's slot assignment (workflows/sc.render.json) in a rolled-back transaction (PLAN §6).
# usage: PSQL="docker exec -i <postgres container> psql -U postgres -d shortcircuit" bash tests/slots.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
PSQL=${PSQL:?set PSQL to a psql command for a database with db/init.sql applied}
q=$(jq -r '.nodes[] | select(.name=="Assign slot") | .parameters.query' workflows/sc.render.json)
{
echo "BEGIN; DELETE FROM schedule; UPDATE jobs SET slot_at = NULL, slot_date = NULL;"
echo "PREPARE slot(int, text, text) AS $q;"
cat <<'SQL'
DO $$ DECLARE a int; b int; c int; x int; s1 timestamptz; s2 timestamptz; bad int := 0; BEGIN
  INSERT INTO jobs (status) VALUES ('script_approved') RETURNING id INTO a;
  INSERT INTO jobs (status) VALUES ('video_editing') RETURNING id INTO b;
  INSERT INTO jobs (status) VALUES ('cancelled') RETURNING id INTO c;
  EXECUTE format('EXECUTE slot(%s, %L, %L)', a, '18:00', 'Asia/Dhaka'); EXECUTE format('EXECUTE slot(%s, %L, %L)', b, '18:00', 'Asia/Dhaka');
  EXECUTE format('EXECUTE slot(%s, %L, %L)', c, '18:00', 'Asia/Dhaka');
  SELECT slot_at INTO s1 FROM jobs WHERE id = a; SELECT slot_at INTO s2 FROM jobs WHERE id = b;
  IF s1 < now() + interval '48 hours' THEN RAISE WARNING 'FAIL slot under 48 h away: %', s1; bad := bad + 1; END IF;
  IF to_char(s1 AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') <> '18:00' THEN RAISE WARNING 'FAIL slot time %', s1; bad := bad + 1; END IF;
  IF s2 <= s1 OR (s2 AT TIME ZONE 'Asia/Dhaka')::date <> (s1 AT TIME ZONE 'Asia/Dhaka')::date + 1 THEN RAISE WARNING 'FAIL second slot % after %', s2, s1; bad := bad + 1; END IF;
  IF (SELECT slot_date FROM jobs WHERE id = c) IS NOT NULL THEN RAISE WARNING 'FAIL cancelled job booked a day'; bad := bad + 1; END IF;
  -- an assigned slot never moves; a freed day is taken by the next render
  EXECUTE format('EXECUTE slot(%s, %L, %L)', a, '12:00', 'Asia/Dhaka');
  IF (SELECT slot_at FROM jobs WHERE id = a) <> s1 THEN RAISE WARNING 'FAIL assigned slot moved'; bad := bad + 1; END IF;
  UPDATE jobs SET status = 'rejected', slot_at = NULL, slot_date = NULL WHERE id = a;
  INSERT INTO jobs (status) VALUES ('script_approved') RETURNING id INTO x;
  EXECUTE format('EXECUTE slot(%s, %L, %L)', x, '18:00', 'Asia/Dhaka');
  IF (SELECT slot_at FROM jobs WHERE id = x) <> s1 THEN RAISE WARNING 'FAIL freed day not reused'; bad := bad + 1; END IF;
  -- the schedule table wins over PUBLISH_TIME
  INSERT INTO schedule (dow, publish_time) SELECT d, '21:00' FROM generate_series(0, 6) d;
  INSERT INTO jobs (status) VALUES ('script_approved') RETURNING id INTO x;
  EXECUTE format('EXECUTE slot(%s, %L, %L)', x, '18:00', 'Asia/Dhaka');
  IF to_char((SELECT slot_at FROM jobs WHERE id = x) AT TIME ZONE 'Asia/Dhaka', 'HH24:MI') <> '21:00' THEN RAISE WARNING 'FAIL schedule ignored'; bad := bad + 1; END IF;
  IF bad > 0 THEN RAISE EXCEPTION '% slot case(s) failed', bad; END IF;
  RAISE NOTICE 'all slot cases passed';
END $$;
ROLLBACK;
SQL
} | $PSQL -v ON_ERROR_STOP=1 -q 2>&1 | grep -E "NOTICE|WARNING|ERROR"; exit ${PIPESTATUS[1]}
