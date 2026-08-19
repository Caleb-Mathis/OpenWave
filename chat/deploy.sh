#!/usr/bin/env bash
# Build a cache-busted copy of this static site and rsync it to the server.
#
# Hashed filenames (app.<sha>.js) force browsers to fetch new assets.
# index.html keeps a stable name so the site URL does not change.
#
# Override destination without editing this file:
#   DEPLOY_REMOTE=user@host:/path ./deploy.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DIST="$ROOT/.deploy"
# This host authorizes ~/.ssh/id_ed25519 for root, not $USER.
REMOTE="${DEPLOY_REMOTE:-root@ssh.xcloud.zip:/var/www/caleb/xcloud/html/chat/}"

short_hash() {
  shasum -a 256 "$1" | awk '{print substr($1, 1, 8)}'
}

log() {
  printf '==> %s\n' "$*"
}

rm -rf "$DIST"
mkdir -p "$DIST"

log "Building cache-busted site in ${DIST#"$ROOT/"}"

replacements="$(mktemp)"
trap 'rm -f "$replacements"' EXIT

# Hash cacheable CSS/JS. Leave HTML, the service worker, manifest, and icons
# at stable names so the PWA can install and update.
while IFS= read -r -d '' src; do
  rel="${src#"$ROOT"/}"
  case "$rel" in
    deploy.sh|.DS_Store)
      continue
      ;;
    *.html|*.htm)
      continue
      ;;
  esac

  dir="$(dirname "$rel")"
  name="$(basename "$rel")"
  if [ "$dir" != "." ]; then
    mkdir -p "$DIST/$dir"
  fi

  should_hash=0
  case "$rel" in
    sw.js) should_hash=0 ;;
    *.js|*.css) should_hash=1 ;;
  esac

  if [ "$should_hash" -eq 1 ]; then
    ext="${name##*.}"
    base="${name%.*}"
    hashed="${base}.$(short_hash "$src").${ext}"
    dest_rel="$hashed"
    if [ "$dir" != "." ]; then
      dest_rel="$dir/$hashed"
    fi
    cp "$src" "$DIST/$dest_rel"
    printf '%s\t%s\n' "$rel" "$dest_rel" >>"$replacements"
    log "  $rel -> $dest_rel"
  else
    cp "$src" "$DIST/$rel"
    log "  $rel"
  fi
done < <(find "$ROOT" \( -path "$ROOT/.deploy" -o -path "$ROOT/.git" \) -prune -o -type f -print0)

# Copy HTML and rewrite asset references to hashed names.
while IFS= read -r -d '' src; do
  rel="${src#"$ROOT"/}"
  case "$rel" in
    *.html|*.htm)
      ;;
    *)
      continue
      ;;
  esac

  dir="$(dirname "$rel")"
  if [ "$dir" != "." ]; then
    mkdir -p "$DIST/$dir"
  fi
  dest="$DIST/$rel"
  cp "$src" "$dest"

  while IFS=$'\t' read -r original hashed; do
    [ -n "$original" ] || continue
    perl -i -0pe "s/\Q$original\E/$hashed/g" "$dest"
  done <"$replacements"

  log "  $rel (rewritten)"
done < <(find "$ROOT" \( -path "$ROOT/.deploy" -o -path "$ROOT/.git" \) -prune -o -type f -print0)

log "Syncing to $REMOTE"
rsync -avz --delete --exclude '.DS_Store' "$DIST/" "$REMOTE"

log "Deployed."

