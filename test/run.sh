#!/bin/sh
# Runs the tests against CLICKHOUSE_URL, or, without one, a throwaway ClickHouse
# container (what CI does).
set -e
if [ -z "$CLICKHOUSE_URL" ]; then
    name=click-log-test-$$
    docker run -d --rm --name "$name" -p 127.0.0.1:18123:8123 -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server:25.8 >/dev/null
    trap 'docker stop "$name" >/dev/null' EXIT
    export CLICKHOUSE_URL=http://127.0.0.1:18123 CLICKHOUSE_PASSWORD=test
    i=0
    until curl -sf "$CLICKHOUSE_URL/ping" >/dev/null; do
        i=$((i + 1))
        [ "$i" -lt 60 ] || { echo 'clickhouse did not start'; exit 1; }
        sleep 1
    done
fi
npx -y bun@1.4.2 test
