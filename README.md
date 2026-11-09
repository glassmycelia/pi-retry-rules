# pi-retry-rules

[English](README.md) · [简体中文](docs/readme/zhCN/README.md)

Retry failed Pi model requests without adding a “continue” prompt or replaying the failed assistant reply.

- **Automatic retries:** opt-in provider/model/error rules feed Pi's native retry scheduler.
- **`/retry`:** manually request the failed response again, once. It does not create an automatic rule or a separate retry loop.
- **`/retry-rules`:** manage rules, language, configuration paths and native retry settings inside Pi.
- Status is shown only during recovery: `Retry in progress (1/3)` or `Manual retry in progress (1/1)`. It clears after success, failure or cancellation; there is no idle rule-count banner.
- Keep errors in raw session history while excluding failed replies, including partial text, from subsequent model context.
- Keep completed tool results; the retry mechanism does not rerun completed tools.
- No extra runtime dependencies, private Pi API patches or independent network clients.

## Requirements and installation

Tested with Pi **1.5.0**. Use Node.js **22.19.0 or newer** and a Pi installation that provides the `@earendil-works` host packages. Older Pi API versions are not supported by this release.

### Local installation

Copy or clone this directory onto the target machine, then run:

```bash
pi install /path/to/pi-retry-rules
```

Local installs reference the directory without copying it. Run `/reload` in an existing Pi conversation after installation or a source update. To try it without changing Pi's installed package list:

```bash
pi -e /path/to/pi-retry-rules/index.js
```

Pi supplies the host packages. Installing the development dependencies is only necessary to run this repository's checks.

### Git installation

Install the tagged GitHub release:

```bash
pi install git:github.com/glassmycelia/pi-retry-rules@v0.4.1
```

Pin a tag or commit for reproducible installs. Add `--local` to limit installation to a trusted project. This project is distributed through GitHub; no npm publication is required.

Do not load another extension that also registers `/retry`.

## Commands

### `/retry`

When Pi is idle and the last model-facing conversation message is an assistant error, retry that response from the preceding valid context. The command rejects successful replies, user cancellations, new conversations and busy sessions.

It adds no user instruction. A hidden control entry starts the run, is filtered from provider requests, and is then durably omitted together with the failed reply using Pi's `context_edit` entries. Raw history remains available for diagnosis.

**“Once” means one manual trigger, not a hard limit of one HTTP request.** Pi's existing automatic retries, provider retries and normal tool loops remain enabled. The command does not introduce temporary automatic rules. A later error that matches an existing policy may therefore retry automatically. The model can also choose to call a tool again; this extension does not enforce tool idempotency.

### `/retry-rules`

Open the configuration menu in Pi's TUI or an RPC client supporting extension dialogs:

| Menu item | Purpose |
| --- | --- |
| Enable/disable automatic rules | Toggle this extension's extra retry classification, not Pi's native retry switch |
| Add/edit/delete rule | Edit provider ID, optional model ID and matching terms |
| Edit full configuration JSON | Edit every extension setting; repair malformed configuration after confirmation |
| Configuration path | Select or create another rule file for this session |
| Pi native retry settings | Edit native retry budgets, delays and provider timeout/retry settings |
| Language | Switch between English and Simplified Chinese |
| View configuration | Show active path, rules and effective native settings |
| Reload configuration | Read external file edits without restarting Pi |

Rule and language changes apply immediately after a successful save. Native settings require confirmation and a Pi reload, which the command requests automatically. They are saved to either user `settings.json` or trusted project `.pi/settings.json`, preserving unrelated fields. Project settings can override user settings. Native settings affect Pi itself and other extensions using its scheduler.

## Configuration and language

The default file is:

```text
<Pi agent directory>/pi-retry-rules.json
```

Usually this is `~/.pi/agent/pi-retry-rules.json`. Pi's `PI_CODING_AGENT_DIR` override is respected. User configuration is **not stored in the extension checkout or published package**, so updating the extension does not reset it.

When the file does not exist, the extension uses these defaults in memory and writes a file only when the user saves:

```json
{
  "enabled": false,
  "language": "en",
  "rules": []
}
```

`language` accepts `en` or `zh-CN`; older configurations without it use English. It controls extension dialogs, notices and status labels, not Pi's own UI, provider errors, command names or user-entered matching text. Command discovery descriptions stay in English. There is no locale auto-detection.

A generic example for a gateway that incorrectly wraps a transient failure in HTTP 400:

```json
{
  "enabled": true,
  "language": "en",
  "rules": [
    {
      "provider": "example-gateway",
      "model": "example-model",
      "contains": ["API error (400)", "temporary upstream rejection"]
    }
  ]
}
```

- `provider` is Pi's connection/provider ID, not necessarily the model vendor.
- `model` matches the model **ID**, not its display name. Omit it to match every model on that provider.
- Each `contains` term is a case-sensitive literal substring. **All terms in one rule must match.** Any matching rule is sufficient.
- Provider is required. There is no all-provider wildcard or regular-expression syntax.
- Cancelled replies, authentication/permission failures and context overflows are not reclassified. Pi's own fatal quota/billing exclusions remain authoritative.
- Malformed configuration disables extra automatic rules; it is not silently overwritten. Repair requires confirmation through the full JSON editor.

To choose a file at startup:

```bash
pi --retry-rules-config /path/to/private-rules.json
```

Load the extension first, or combine this flag with `-e`. A path selected in the menu is stored as branch-local session metadata and survives resume, reload and tree navigation. New sessions use the startup flag or default path. Keep credentials, personal identifiers and full conversation text out of matching rules. Never commit your actual configuration.

## Native retry parameters

Use the menu to edit Pi's existing `retry` settings. The extension does not keep a competing copy of them. Delays/timeouts use milliseconds; counts must be nonnegative integers.

```json
{
  "enabled": true,
  "maxRetries": 3,
  "baseDelayMs": 2000,
  "maxAgentDelayMs": 60000,
  "provider": {
    "maxRetries": 0,
    "maxRetryDelayMs": 60000
  }
}
```

`provider.timeoutMs` is optional; remove it to clear the value in the selected settings scope and inherit the relevant Pi timeout. `0` disables that timeout. Keep provider-level retries at `0` unless they are needed: nested retries can multiply requests and delay recovery. The menu accepts millisecond values from `0` to `2147483647`.

## How it works and limits

Automatic rules use `message_end` to preserve the error text and append an explicit local-policy retry hint recognized by Pi. Pi then owns backoff, cancellation, budgets and durable context omission. This depends on Pi's current retry classifier, so re-run tests after Pi upgrades.

Manual retry uses public `sendMessage`, `context`, `context_with_system`, `turn_end` and `agent_before_settle` hooks. It does not cache or replay raw HTTP packets. Requests are regenerated through Pi's provider pipeline; other extensions, routing, compaction or configuration changes can alter them.

Files are validated before replacement. Concurrent extension saves are serialized and external edits are detected. A process crash during a rule save can leave `<config>.lock`; remove it only after verifying that no session is saving. Existing malformed files are retained. Pi settings use its lock-directory convention.

## Development and release checks

```bash
npm ci --registry=https://registry.npmjs.org --no-audit --no-fund
npm run check
npm audit --registry=https://registry.npmjs.org
npm pack --dry-run
```

Tests use temporary configuration/session directories, mock credentials and a mocked `fetch` with Pi's actual OpenAI serializer. They cover automatic/manual recovery, partial output, request-payload equality, retained tool results, cancellation, exhaustion, reload/resume, concurrent saves, language and configuration controls. They do not contact live model providers or validate every platform/provider combination.

Release content is allowlisted in `package.json`. Actual user rules, local JSON overrides, secrets, lock/temp files, archives and `node_modules/` are not release inputs. Review the package listing and Git diff before publishing.

## License

[MIT](LICENSE).
