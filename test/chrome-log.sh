#!/bin/sh
# 测试用的 Chrome 启动壳（test/harness.mjs 的 launchChrome 用，见 test/README.md「Chrome 中途退出」）：
# Chrome 的 stderr 整个写进 $CINDER_CHROME_STDERR，开头记 Chrome 的 pid，结尾记它的退出码（128 + n = 被信号 n 杀掉）。
# Playwright 关浏览器时连这个壳一起杀（整个进程组），那种情况下没有结尾那行。
log=${CINDER_CHROME_STDERR:-/dev/null}
"${CINDER_CHROME_BIN:-/opt/google/chrome/chrome}" "$@" 2>>"$log" &
pid=$!
echo "$(date -u +%H:%M:%S.%3NZ) <chrome pid=$pid>" >>"$log"
trap 'kill -TERM $pid 2>/dev/null' TERM INT HUP
wait $pid
rc=$?
while kill -0 $pid 2>/dev/null; do wait $pid; rc=$?; done
echo "$(date -u +%H:%M:%S.%3NZ) <chrome exit rc=$rc>" >>"$log"
exit $rc
