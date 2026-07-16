# Agent Task Loop V0.2 Model Service Configuration Design

## Goal

Let an Obsidian user choose whether ATL follows the current Claude Code configuration or uses an ATL-specific model and Base URL. The interaction should feel familiar to CC-Switch users without turning ATL into a credential manager or a general provider catalog.

## Product Boundary

### Included

- Add a model configuration mode under `后台执行`:
  - `沿用 Claude Code 当前配置`
  - `自定义服务`
- In custom mode, accept a model identifier and an `http` or `https` Base URL.
- Persist the mode, model, and Base URL in the plugin's `data.json`.
- Write the selected non-secret override into the managed LaunchAgent.
- Keep existing v0.1 and v0.2 plugin settings compatible.
- Explain that research content is sent to the configured service.

### Excluded

- Storing, editing, importing, or displaying API keys and auth tokens.
- A provider list, multiple saved profiles, health benchmarking, failover, or model discovery.
- Editing `~/.claude/settings.json` or CC-Switch state.
- Supporting OpenAI-compatible clients that cannot be reached through Claude Code.

## User Experience

The `后台执行` section adds a `模型服务` dropdown.

`沿用 Claude Code 当前配置` is the default and recommended mode. ATL does not override the model or Base URL. Claude Code resolves both from its current configuration, including settings managed by CC-Switch.

`自定义服务` reveals two text inputs:

- `Model`: a model identifier such as `glm-4-flash`.
- `Base URL`: an absolute `http` or `https` endpoint such as `https://example.com/api/anthropic`.

The custom form includes a persistent disclosure: `Agent 调研时会把任务目标和已授权资料发送到该服务。API Key 仍由 Claude Code 或系统环境管理，ATL 不会保存。`

Changing a field saves plugin settings but does not silently rewrite the active LaunchAgent. If background execution is already installed, the existing `更新后台配置` button applies the new values. Invalid custom values disable that action and show a field-level description.

## Data Model And Migration

`BackgroundSettings` gains:

```ts
type ModelServiceMode = 'inherit' | 'custom';

interface BackgroundSettings {
  modelServiceMode: ModelServiceMode;
  model: string;
  baseUrl: string;
  // existing runtime paths, roots, and daily limit remain unchanged
}
```

New installations default to `inherit`, an empty Base URL, and the existing conservative model fallback. Existing settings that contain a non-default model but no mode migrate to `custom` only when a valid Base URL is also present; otherwise they migrate to `inherit`. This prevents an upgrade from unexpectedly overriding CC-Switch with the historical `claude-sonnet-4-5` default.

Custom mode requires both fields. Model identifiers keep the existing allowlist pattern: 1 to 200 characters, beginning with an alphanumeric character and containing only alphanumerics plus `. _ : / -`. Base URLs must parse through the platform URL parser, use `http:` or `https:`, contain a hostname, and contain no username, password, query, or fragment. The normalized URL removes a trailing root slash only when serialization adds one.

## Runtime Data Flow

In inherit mode, `BackgroundRuntimeController` omits both `ATL_CLAUDE_MODEL` and `ANTHROPIC_BASE_URL` from the scheduler environment. The Claude driver therefore omits `--model`, while Claude Code reads its own model, endpoint, and auth from the configured `CLAUDE_CONFIG_DIR`.

In custom mode, the controller passes:

```text
ATL_CLAUDE_MODEL=<validated model>
ANTHROPIC_BASE_URL=<validated Base URL>
```

`renderLaunchAgent` treats both variables as optional but validates them when present. It serializes only these non-secret values. The Claude driver already allowlists `ANTHROPIC_BASE_URL` into its isolated child environment and passes the selected model through `--model`.

API keys and auth tokens are never copied into the LaunchAgent. Claude Code continues to load them from its own configuration or credential mechanism. ATL logs and user-facing errors never include environment values.

## Error Handling

- Invalid custom Model: `Model 格式无效，请检查模型名称。`
- Invalid Base URL: `Base URL 必须是完整的 http 或 https 地址。`
- Missing custom value: the update action is disabled until both values are valid.
- Endpoint or credential failure during execution: retain the existing sanitized runner failure; do not echo URL query data, token data, or Claude stderr into task content.
- Existing managed scheduler: settings changes remain pending until the user clicks `更新后台配置`.

## Testing

- Settings normalization covers fresh installs, legacy migration, malformed modes, model validation, and Base URL normalization.
- UI-oriented pure state tests cover inherit/custom visibility and action validity without requiring Obsidian DOM integration.
- Controller tests prove inherit mode omits overrides and custom mode emits only model and Base URL.
- LaunchAgent tests prove optional variables are omitted, valid overrides are XML-escaped, invalid URLs are rejected, and no secret variables are serialized.
- Claude driver regression tests prove the existing Base URL allowlist and optional `--model` behavior remain intact.
- Release verification inspects generated plugin assets and the installed plist without printing credential values.

## Acceptance Criteria

1. A user can switch between following Claude Code and an ATL-specific model service entirely inside Obsidian.
2. In inherit mode, ATL follows the active Claude Code or CC-Switch configuration without writing a model or Base URL override.
3. In custom mode, ATL persists and applies a valid Model and Base URL after the user clicks `启用后台执行` or `更新后台配置`.
4. Invalid or credential-bearing URLs cannot be installed into the LaunchAgent.
5. API keys and auth tokens do not appear in the Vault, plugin `data.json`, managed plist, logs, release files, or Git history.
6. Existing users upgrade without silently replacing their current Claude Code model service.
7. The real Vault installation can update its managed LaunchAgent to the packaged `atl-runner.mjs` and complete a bounded manual check without moving Inbox candidates.
