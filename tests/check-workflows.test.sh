#!/bin/bash
# Tests scripts/check-workflows.mjs: the real exports pass; each planted violation fails.
set -u
cd "$(dirname "$0")/.."
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fails=0
expect() { # expect <0|1> <name> <jq filter on one file> <file>
  rm -rf "$T/w"; cp -R workflows "$T/w"
  [ -n "$3" ] && { jq "$3" "workflows/$4" > "$T/w/$4"; }
  node scripts/check-workflows.mjs "$T/w" > "$T/out" 2>&1; got=$?
  if [ "$got" = "$1" ]; then echo "ok   $2"; else echo "FAIL $2 (exit $got)"; cat "$T/out"; fails=$((fails+1)); fi
}
gmail='{name:"x",type:"n8n-nodes-base.gmail",typeVersion:2.1,parameters:{sendTo:"={{ $env.OWNER_EMAIL }}",subject:"s",message:"m"}}'
expect 0 "exported workflows pass" "" ""
expect 1 "Gmail send outside sc.mail" ".nodes += [$gmail]" sc.alert.json
expect 1 "send-and-wait outside sc.review" ".nodes += [($gmail | .parameters.operation=\"sendAndWait\")]" sc.render.json
expect 1 "recipient not OWNER_EMAIL" "(.nodes[] | select(.type==\"n8n-nodes-base.gmail\") | .parameters.sendTo) = \"a@b.c\"" sc.mail.json
expect 1 "HTTP with Gmail Bot credential" '.nodes += [{name:"h",type:"n8n-nodes-base.httpRequest",typeVersion:4.2,parameters:{method:"POST",url:"https://gmail.googleapis.com/x",authentication:"predefinedCredentialType",nodeCredentialType:"gmailOAuth2"}}]' sc.render.json
expect 1 "YouTube upload outside sc.publish" '.nodes += [{name:"y",type:"n8n-nodes-base.youTube",typeVersion:1,parameters:{resource:"video",operation:"upload"}}]' sc.livecheck.json
expect 1 "YouTube POST by HTTP outside sc.publish" '.nodes += [{name:"y",type:"n8n-nodes-base.httpRequest",typeVersion:4.2,parameters:{method:"POST",url:"u",authentication:"predefinedCredentialType",nodeCredentialType:"youTubeOAuth2Api"}}]' sc.livecheck.json
expect 1 "Drive share outside sc.config" '.nodes += [{name:"d",type:"n8n-nodes-base.googleDrive",typeVersion:3,parameters:{resource:"folder",operation:"share",permissionsUi:{permissionsValues:{type:"user",role:"reader"}}}}]' sc.render.json
expect 1 "Drive share to anyone" '(.nodes[] | select(.name=="Share folder") | .parameters.permissionsUi.permissionsValues.type) = "anyone"' sc.config.json
expect 1 "HTTP Request Tool on the Master" '.nodes += [{name:"web",type:"n8n-nodes-base.httpRequestTool",typeVersion:4.2,parameters:{url:"u"}}] | .connections.web = {ai_tool:[[{node:"Master",type:"ai_tool",index:0}]]}' sc.master.json
expect 1 "reject_job without approval" '.connections.reject_job.ai_tool = [[{node:"Master",type:"ai_tool",index:0}]]' sc.master.json
expect 1 "triage action tool with a model-chosen job" '(.nodes[] | select(.name=="retry_job") | .parameters.workflowInputs.value.job) = "={{ $fromAI(\"job\") }}"' sc.master.json
[ $fails = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
