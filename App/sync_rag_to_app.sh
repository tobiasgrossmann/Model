#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT_DIR/rag"
DST="$ROOT_DIR/App/FitCoachApp/Resources/RAG"

mkdir -p "$DST"
rsync -a --delete --include='*.md' --exclude='*' "$SRC/" "$DST/"

echo "Synced RAG markdown files to $DST"
