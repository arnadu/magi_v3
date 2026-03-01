---
name: skill-creator
description: |
  Create a new reusable skill package for the team or for yourself.
  Use when you want to document a convention or procedure so it persists.
---

# Skill Creator

Document a convention or procedure as a reusable skill so it can be shared
with the team this mission or remembered for future missions.

## When to use

- You have discovered a procedure that would benefit the whole team
- A team member asks you to formalise a convention
- You want to record a personal shortcut for your private use

## Steps

1. Decide on the skill name (lowercase, hyphens only, max 64 chars)

2. Choose where to save it (paths shown in your Available Skills section):
   - **Mission skill** (visible to all team members this mission): use the mission path
   - **Your private skill**: use your private path

3. Run the init script to scaffold the directory:
   ```bash
   bash <platform-skills-path>/skill-creator/scripts/init_skill.sh \
     "<skill-name>" \
     "<destination-path>"
   ```

4. Read the scaffolded `SKILL.md` and fill it in:
   - `name` in the frontmatter (must match the directory name)
   - `description`: 1–3 lines; this is what teammates see in their skill list
   - Body: step-by-step instructions; be explicit about file paths

5. Add scripts to `scripts/` if deterministic execution is needed

6. See `references/design-patterns.md` for skill design guidance

## Example

```bash
# Create a mission skill for a report format convention
bash /missions/my-mission/shared/skills/_platform/skill-creator/scripts/init_skill.sh \
  "report-format" \
  "/missions/my-mission/shared/skills/mission"

# Then edit the scaffolded SKILL.md
cat /missions/my-mission/shared/skills/mission/report-format/SKILL.md
```
