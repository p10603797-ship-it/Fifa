#!/usr/bin/env bash
# SGN-04 refresh: the proxy gate as specified, three times on an idle container, on the SGN-03 build.
cd /home/user/Fifa
for i in 1 2 3; do
  [ -f reports/sgn-03/bench-$i.json ] && continue
  for w in $(seq 1 60); do awk "{exit !(\$1 < 0.8)}" /proc/loadavg && break; sleep 5; done
  echo "load before run $i: $(cat /proc/loadavg)" > reports/sgn-03/bench-$i.log
  ( time npx tsx tools/bench.ts --dist dist-e2e/sgn-03 --throttle 4 --json reports/sgn-03/bench-$i.json ) >> reports/sgn-03/bench-$i.log 2>&1
  echo "EXIT $?" >> reports/sgn-03/bench-$i.log
  sleep 20
done
echo DONE > reports/sgn-03/bench.done
