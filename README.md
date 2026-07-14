# Agent Task Loop

Agent Task Loop V0.1 uses Markdown files in an Obsidian-compatible vault as the
task source of truth. The CLI supports human capture and confirmation, a
supervised research claim, Artifact submission, and human review.

## Requirements

- Node.js 24 or newer
- pnpm 10 or newer

Install dependencies with `pnpm install`.

## Safe manual walkthrough

Run the first walkthrough only against a disposable fixture vault:

```bash
export ATL_VAULT_ROOT="$(mktemp -d -t atl-manual-XXXXXX)"
cp -R tests/fixtures/vault/. "$ATL_VAULT_ROOT/"
unset ATL_ALLOW_REAL_WRITES

pnpm atl project create \
  --project-id public-research \
  --name "Public research" \
  --description "Research only public sources."

TASK_ID="$(pnpm --silent atl task capture \
  --title "Review public pricing" \
  --body "Compare the public pricing page." \
  --origin manual_cli \
  --source-date 2026-07-15 \
  --source-key manual:readme:pricing \
  --priority high \
  --json | node -pe "JSON.parse(require('fs').readFileSync(0, 'utf8')).taskId")"

pnpm --silent atl task list --status inbox --json

pnpm atl task confirm \
  --task-id "$TASK_ID" \
  --project-id public-research \
  --objective "Compare public pricing using official evidence." \
  --acceptance-criterion "Cite an official HTTPS page." \
  --priority high \
  --auto-executable

pnpm --silent atl task next --json

pnpm atl task next \
  --claim \
  --task-id "$TASK_ID" \
  --agent human-supervised \
  --run-id run-readme-001

cat > "$ATL_VAULT_ROOT/result.json" <<'JSON'
{
  "summary": "Pricing was reviewed.",
  "findings": ["A public plan exists."],
  "evidence": [
    {
      "title": "Official pricing",
      "url": "https://example.com/pricing",
      "accessedAt": "2026-07-15T09:00:00.000Z"
    }
  ],
  "uncertainties": [],
  "recommendedActions": ["Review again next quarter."],
  "acceptance": [
    {
      "criterion": "Cite an official HTTPS page.",
      "status": "met",
      "note": "The official pricing page was cited."
    }
  ]
}
JSON

pnpm atl task submit \
  --task-id "$TASK_ID" \
  --run-id run-readme-001 \
  --result "$ATL_VAULT_ROOT/result.json"

pnpm atl task review --task-id "$TASK_ID" --approve
pnpm --silent atl doctor --json
find "$ATL_VAULT_ROOT/10_Tasks/Archive" -name "$TASK_ID.md"
find "$ATL_VAULT_ROOT/10_Tasks/Artifacts/$TASK_ID" -name 'attempt-*.md'
```

`task next --json` is read-only. A supervised claim must include `--claim`, an
explicit `--task-id`, and a `--run-id`. Supervised claims use manual mode and do
not consume the automatic daily quota. The default automatic daily limit is 3,
the claim lease is 60 minutes, and the future board bind is fixed to
`127.0.0.1`.

Human recovery commands are available at the trusted CLI boundary:

```bash
pnpm atl task stop --task-id "$TASK_ID"
pnpm atl task unblock --task-id "$TASK_ID" --feedback "Scope supplied."
pnpm atl task reopen --task-id "$TASK_ID" --feedback "More work is required."
```

> [!WARNING]
> Do not point the walkthrough at the real ClawVault. Real writes require both
> the exact vault root and the explicit write flag:
>
> ```bash
> export ATL_VAULT_ROOT="/Users/linctex/Documents/ClawVault"
> export ATL_ALLOW_REAL_WRITES=1
> pnpm --silent atl task list --status inbox --json
> # Run a mutating command only after reviewing its arguments.
> ```

## Storage doctor

`atl doctor --json` is read-only. It exits with status 1 when it finds duplicate
task IDs, invalid frontmatter, lifecycle path mismatches, or stale/missing task
index links. Each path mismatch includes the expected lifecycle path for manual
repair; the command never repairs files itself.
