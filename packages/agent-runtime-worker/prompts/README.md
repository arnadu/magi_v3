# Platform prompts

The text MAGI itself sends to a model: the mission copilot's system prompt and
starting mental map, the Research sub-agent, reflection, BrowseWeb's browser
agent, the image description/OCR prompts, and the notes appended to every
agent's system prompt. A team's own agent prompts are not here — they live in
its config YAML (`config/teams/`).

Loaded by `loadPrompt()` in `src/prompts.ts`; each file name is listed in its
`PromptFile` type.

- **Placeholders** are `{{name}}`. The caller fills the ones it passes, in a
  single pass. Others stay as written for a later stage: `{{mentalMap}}`,
  `{{sharedDir}}` and `{{workdir}}` are filled per session by
  `buildSystemPrompt`, or once at agent creation for a starting mental map.
- **The final newline** of a file is not part of the prompt; any other
  whitespace is.
- **A new prompt** needs its file here, its name in `PromptFile`, and the
  matching entry in `tests/prompts.unit.test.ts`.

Both Docker images ship this folder. `.dockerignore` excludes `*.md` except
what it re-includes, so keep its `prompts/` exception if you move the folder.
