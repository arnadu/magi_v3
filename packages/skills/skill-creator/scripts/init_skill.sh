#!/usr/bin/env bash
# init_skill.sh — scaffold a new skill directory.
#
# Usage:
#   init_skill.sh <skill-name> <destination-path>
#
# Creates:
#   <destination-path>/<skill-name>/SKILL.md   (template)
#   <destination-path>/<skill-name>/scripts/   (empty dir)

set -euo pipefail

SKILL_NAME="${1:?skill-name required}"
DEST_PATH="${2:?destination-path required}"

# Validate skill name: lowercase letters, digits, hyphens; max 64 chars.
if ! printf '%s' "$SKILL_NAME" | grep -qE '^[a-z][a-z0-9-]{0,63}$'; then
  echo "Error: skill name must start with a letter and contain only lowercase" >&2
  echo "letters, digits, and hyphens (max 64 chars). Got: $SKILL_NAME" >&2
  exit 1
fi

SKILL_DIR="$DEST_PATH/$SKILL_NAME"

if [ -d "$SKILL_DIR" ]; then
  echo "Error: skill directory already exists: $SKILL_DIR" >&2
  exit 1
fi

mkdir -p "$SKILL_DIR/scripts"

cat > "$SKILL_DIR/SKILL.md" << TEMPLATE
---
name: $SKILL_NAME
description: |
  One-line description shown in the team's skill list.
  Add more context here if needed (up to 3 lines).
---

# $SKILL_NAME

## When to use

Describe the trigger condition: when should an agent read and follow this skill?

## Steps

1. Step one
2. Step two
3. Step three

## Examples

Show a concrete example of the skill in action.
TEMPLATE

echo "Skill scaffolded at: $SKILL_DIR"
echo "Next: edit $SKILL_DIR/SKILL.md to complete the skill definition."
