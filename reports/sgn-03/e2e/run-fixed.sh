#!/usr/bin/env bash
# SGN-03: the specs whose harness was fixed in this campaign, run whole after the fix (<spec>.fixed.json/.log).
cd /home/user/Fifa
OUT=reports/sgn-03/e2e
export PW_DIST=dist-e2e/sgn-03 PW_PORT=4503
for s in "$@"; do
  load=$(cut -d' ' -f1 /proc/loadavg); t0=$(date +%s)
  PLAYWRIGHT_JSON_OUTPUT_NAME=$OUT/$s.fixed.json timeout 1500 npx playwright test tests/e2e/$s.spec.ts --project=chromium-ipad --reporter=list,json > $OUT/$s.fixed.log 2>&1
  ec=$?; t1=$(date +%s)
  st=$(node -e 'try{const j=require(process.argv[1]).stats;console.log([j.expected,j.unexpected,j.flaky,j.skipped].join("\t"))}catch(e){console.log("NA\tNA\tNA\tNA")}' "$PWD/$OUT/$s.fixed.json")
  printf '%s\t%s\t%s\t%s\t%s\n' "$s.fixed" "$ec" "$st" "$((t1-t0))" "$load" >> $OUT/summary.tsv
done
