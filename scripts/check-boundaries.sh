#!/usr/bin/env bash
# Boundary check for the Warrior engine isolation rules in CLAUDE.md.
#
# Classic <script> tags all share one global scope, so "core/ never imports
# from engines/" and "no setup names outside engines/warrior/" cannot be
# enforced by the language (see docs/warrior-engine-spec-v2.md Phase 0,
# "The import boundary is convention, not enforcement"). This grep-based
# check is the only enforcement available. Run it as part of every phase's
# acceptance pass. Exits non-zero on any violation.
#
# Directories that don't exist yet (engines/, shell/) are skipped silently —
# most of this repo's phases haven't been built yet.
#
# Comment lines (`// ...`) are stripped before matching, so a rule-stating
# header comment (e.g. "core/ never imports from engines/") doesn't trip
# its own check.

set -u
fail=0

# Setup names/ids that may only appear inside engines/warrior/ — never in
# core/, engines/edge/, or shell/. Both the Title Case display strings and
# the kebab-case id strings are checked.
SETUP_TERMS=(
  'ABCD'
  'Gap and Go'
  'VWAP Momentum'
  'Red-to-Green'
  'HOD Momentum'
  'gap-and-go'
  'vwap-momentum'
  'hod-momentum'
  'red-to-green'
)

# Prints "file:line" for every non-comment-only line in $2.. matching literal
# string $1. A line is "comment-only" if, after stripping anything from the
# first // onward, nothing but whitespace remains.
grep_code() {
  local term="$1"; shift
  for f in "$@"; do
    awk -v term="$term" '
      { code = $0; sub(/\/\/.*/, "", code) }
      index(code, term) > 0 { print FILENAME ":" FNR }
    ' "$f"
  done
}

check_dir_for_terms() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  local files
  files=$(find "$dir" -name '*.js')
  [ -z "$files" ] && return 0

  for term in "${SETUP_TERMS[@]}"; do
    local hits
    hits=$(grep_code "$term" $files)
    if [ -n "$hits" ]; then
      echo "FAIL: '$term' found outside engines/warrior/:"
      echo "$hits" | sed 's/^/  /'
      fail=1
    fi
  done
}

check_dir_for_terms "core"
check_dir_for_terms "engines/edge"
check_dir_for_terms "shell"

# core/ must never reference engines/ in actual code (import, dynamic
# import, a path string) — comment-only mentions (e.g. this rule being
# stated in a header) don't count.
if [ -d "core" ]; then
  files=$(find core -name '*.js')
  if [ -n "$files" ]; then
    hits=$(grep_code "engines/" $files)
    if [ -n "$hits" ]; then
      echo "FAIL: core/ references engines/ in code:"
      echo "$hits" | sed 's/^/  /'
      fail=1
    fi
  fi
fi

# engines/* must never import each other.
if [ -d "engines/edge" ]; then
  files=$(find engines/edge -name '*.js')
  if [ -n "$files" ]; then
    hits=$(grep_code "engines/warrior" $files)
    if [ -n "$hits" ]; then
      echo "FAIL: engines/edge/ references engines/warrior/ in code:"
      echo "$hits" | sed 's/^/  /'
      fail=1
    fi
  fi
fi
if [ -d "engines/warrior" ]; then
  files=$(find engines/warrior -name '*.js')
  if [ -n "$files" ]; then
    hits=$(grep_code "engines/edge" $files)
    if [ -n "$hits" ]; then
      echo "FAIL: engines/warrior/ references engines/edge/ in code:"
      echo "$hits" | sed 's/^/  /'
      fail=1
    fi
  fi
fi

# Phase 2 acceptance: "app.js holds no stored reference to the Warrior
# module after register() returns... every call into Warrior code goes
# through the registry, no exceptions, so the boundary check is mechanical
# rather than a judgement call." Enforced here as: app.js may reference
# engines/warrior/ at most once, and if it does, that one reference must be
# a dynamic import() — never a static import, require(), or <script> src.
# More than one hit means something outside loadWarriorEngine() is
# reaching toward Warrior code (most likely a stored module reference).
if [ -f "app.js" ]; then
  hits=$(grep_code "engines/warrior" app.js)
  if [ -z "$hits" ]; then hit_count=0; else hit_count=$(echo "$hits" | wc -l); fi
  if [ "$hit_count" -gt 1 ]; then
    echo "FAIL: app.js references engines/warrior/ more than once — should be exactly the one dynamic import() call in loadWarriorEngine():"
    echo "$hits" | sed 's/^/  /'
    fail=1
  elif [ "$hit_count" -eq 1 ]; then
    line_no=$(echo "$hits" | head -1 | cut -d: -f2)
    line_content=$(sed -n "${line_no}p" app.js)
    if ! echo "$line_content" | grep -q "import("; then
      echo "FAIL: app.js's one engines/warrior/ reference is not a dynamic import() call:"
      echo "  app.js:$line_no: $line_content"
      fail=1
    fi
  fi
fi

# shell/ reaches Warrior only through getEngine() — shell/registry.js's own
# contract contains no literal path reference at all, so any hit here means
# some shell/ file is reaching around the registry.
if [ -d "shell" ]; then
  files=$(find shell -name '*.js')
  if [ -n "$files" ]; then
    hits=$(grep_code "engines/warrior" $files)
    if [ -n "$hits" ]; then
      echo "FAIL: shell/ references engines/warrior/ directly (must go through getEngine() only):"
      echo "$hits" | sed 's/^/  /'
      fail=1
    fi
  fi
fi

if [ "$fail" -eq 0 ]; then
  echo "OK: boundary check passed."
fi
exit $fail
