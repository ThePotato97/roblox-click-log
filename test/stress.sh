#!/bin/sh
# Runs the adversarial endpoint suite against a supplied ClickHouse, or starts
# a production-version container with the same 6 GiB ceiling as the homelab.
set -eu

if [ -z "${CLICKHOUSE_URL:-}" ]; then
    name=click-log-stress-$$
    docker run -d --rm --name "$name" --memory=6g -p 127.0.0.1:18123:8123 \
        -e CLICKHOUSE_PASSWORD=test clickhouse/clickhouse-server:26.9 >/dev/null
    trap 'docker stop "$name" >/dev/null' EXIT
    export CLICKHOUSE_URL=http://127.0.0.1:18123
    export CLICKHOUSE_PASSWORD=test
    i=0
    until curl -sf "$CLICKHOUSE_URL/ping" >/dev/null; do
        i=$((i + 1))
        [ "$i" -lt 120 ] || { echo 'clickhouse did not start'; exit 1; }
        sleep 1
    done
fi

exec node test/stress.mjs
