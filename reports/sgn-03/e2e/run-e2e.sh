#!/usr/bin/env bash
# SGN-03 resumable e2e runner: one spec per Playwright run against dist-e2e/sgn-03 on port 4503.
# Skips specs that already have <spec>.json. A spec with failures is re-run once (<spec>.rerun.json/.log).
# summary.tsv columns: spec exit expected unexpected flaky skipped duration_s load1_at_start
cd /home/user/Fifa
OUT=reports/sgn-03/e2e
export PW_DIST=dist-e2e/sgn-03 PW_PORT=4503
run_one() { # $1 spec name, $2 suffix
  local s=$1 suf=$2 load t0 t1 ec
  load=$(cut -d' ' -f1 /proc/loadavg)
  t0=$(date +%s)
  PLAYWRIGHT_JSON_OUTPUT_NAME=$OUT/$s$suf.json.tmp timeout 1500 npx playwright test tests/e2e/$s.spec.ts --project=chromium-ipad --reporter=list,json > $OUT/$s$suf.log 2>&1
  ec=$?
  t1=$(date +%s)
  mv -f $OUT/$s$suf.json.tmp $OUT/$s$suf.json 2>/dev/null
  local st
  st=$(node -e 'try{const j=require(process.argv[1]).stats;console.log([j.expected,j.unexpected,j.flaky,j.skipped].join("\t"))}catch(e){console.log("NA\tNA\tNA\tNA")}' "$PWD/$OUT/$s$suf.json")
  printf '%s\t%s\t%s\t%s\t%s\n' "$s$suf" "$ec" "$st" "$((t1-t0))" "$load" >> $OUT/summary.tsv
  return $ec
}
for f in tests/e2e/*.spec.ts; do
  s=$(basename $f .spec.ts)
  [ -f $OUT/$s.json ] && continue
  echo "$(date +%T) start $s" >> $OUT/runner.log
  if ! run_one $s ""; then
    echo "$(date +%T) rerun $s" >> $OUT/runner.log
    run_one $s ".rerun"
  fi
  echo "$(date +%T) done $s" >> $OUT/runner.log
done
echo "$(date +%T) ALL DONE" >> $OUT/runner.log
