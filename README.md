# TaskMatrix

An Eisenhower-matrix view for your Obsidian vault. TaskMatrix scans every
markdown file for `#task` checkbox lines and lays them out in a 2×2
**Do / Schedule / Delegate / Delete** grid plus a backlog. Drag a task between
quadrants and the change is written straight back to the source markdown — the
plugin keeps no off-vault state.

> Markdown is the only API. A task's quadrant is a `#tm/qN` tag on the line and
> its status is the checkbox character, so any external tool (or you, by hand)
> can move and complete tasks with ordinary file edits and the matrix updates
> automatically.

## Task format

A task is a markdown checkbox line tagged `#task`:

```
- [ ] Draft the Q4 roadmap #task #tm/q2 ^task-abc123
```

| Piece | Meaning |
|-------|---------|
| `- [ ]` | status — `[ ]` pending, `[/]` in progress, `[x]` completed, `[-]` cancelled |
| `#task` | detection signal (a checkbox line without it is ignored) |
| `#tm/qN` | quadrant — `q1` Do, `q2` Schedule, `q3` Delegate, `q4` Delete; omit for backlog |
| `^task-…` | optional Obsidian block ID — used as the stable task identity, always kept last |

## Usage

- Open the matrix from the ribbon (**Open task matrix**) or the command palette.
- Add a task with the **+** button in the Backlog panel, or the **Add task to backlog** command.
- Drag cards between quadrants and the backlog; placement writes the `#tm/qN` tag.
- Click a card's checkbox to cycle status (Shift+click to cancel).
- Click the file icon on a card to jump to the source line.
- Filter by status or search text from the toolbar; **Rescan** re-indexes the vault.

Writes are atomic and conflict-checked: if a file changed underneath an action
(another editor, a sync backend), TaskMatrix bails out without clobbering and
re-scans.

## Development

```bash
npm install      # install dev dependencies
npm run dev      # esbuild watch → main.js
npm run build    # typecheck (tsc -noEmit) + production bundle → main.js
npm run typecheck
npm test         # node --test against src/parser.ts (no extra deps)
```

The pure parse/mutate logic lives in `src/parser.ts` (no Obsidian imports, the
single source of truth) and is unit-tested in `test/parser.test.ts`. The
Obsidian integration — view, drag-and-drop, vault writes — lives in
`src/main.ts`.

### Manual install into a vault

Build, then copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/task-matrix/` and enable the plugin in Obsidian's
community-plugin settings.

## License

[MIT](LICENSE)
