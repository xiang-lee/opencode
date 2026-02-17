# js

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.2.12. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## Workspace Memory and Automation

Workspace behavior is driven by files under `.opencode/`.

- `.opencode/SOUL.md`: project-level operating principles used by the assistant.
- `.opencode/TOOLS.md`: local tool conventions and usage notes.
- `.opencode/IDENTITY.md`: durable project identity metadata.
- `.opencode/USER.md`: user preferences and interaction defaults.
- `.opencode/HEARTBEAT.md`: scheduled directives for recurring reminders or actions.
- `.opencode/BOOT.md`: startup hook tasks parsed and queued when a session starts.
- `.opencode/BOOTSTRAP.md`: first-run onboarding checklist.
- `.opencode/memory/MEMORY.md`: persistent workspace memory injected only when the session key is `main`.
- `.opencode/memory/YYYY-MM-DD.md`: daily memory log files.
- `.opencode/memory/session/<key>.md`: per-session memory files keyed by session.
- `.opencode/cron/jobs.json`: persisted scheduler job definitions.
- `.opencode/cron/runs/<jobId>.jsonl`: append-only execution history for each job.

### HEARTBEAT directives

Use lightweight directives in `.opencode/HEARTBEAT.md` to control schedule behavior:

- `@every 30m`: run every 30 minutes.
- `@retry 5m`: retry 5 minutes after failure.
- `@quiet 23:00-08:00`: suppress runs during quiet hours.
- `@reply false`: enqueue without immediately running an assistant reply.

### BOOT behavior

At startup, tasks are parsed from `.opencode/BOOT.md` and queued as a startup prompt.
Default behavior is no immediate reply, unless a task includes `@reply true`.

### BOOTSTRAP lifecycle

`.opencode/BOOTSTRAP.md` is created for first-run onboarding.
It is removed automatically after `IDENTITY.md` (`Name`) and `USER.md` (`What-to-call`) are filled.
