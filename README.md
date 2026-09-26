# claude-foundry-image

Claude Code plugin that gives every project and every conversation an image generator
backed by your own Azure AI Foundry deployments of OpenAI's **gpt-image-2.5**, with one
tool per model:

| Tool | Model | Pick it for |
|---|---|---|
| `flare_image` | `gpt-image-2.5-flare` | The default: fast (about 15–25 s at low/medium) high-quality images for everyday work. Blog and social visuals, thumbnails, illustrations, icons, drafts, variations, quick edits. |
| `sunburst_image` | `gpt-image-2.5-sunburst` | The most detailed model, slower. Final deliverables and precise edits that change one thing and keep the rest intact. |

Both tools generate from a prompt, or edit an existing PNG/JPEG when you pass `image`.

- **MCP server** (`server/server.mjs`) — Node ≥ 18, zero dependencies. Tools:
  `flare_image`, `sunburst_image`, `check_config`.
- **Skill `generate-image`** — teaches Claude which model to pick, how to expand a
  one-liner into a usable prompt, valid sizes, where to write files.
- **Skill `setup`** — one-time configuration walkthrough.

Images are written to disk; only the file path enters the conversation. No base64 in
context.

## Install

```bash
claude plugin marketplace add jpaarhuis/claude-foundry-image
```

```bash
claude plugin install foundry-image@jpaarhuis
```

Or in an interactive session: `/plugin` → Marketplaces → add `jpaarhuis/claude-foundry-image`
→ install `foundry-image`.

## Deploy the models

Both models live on one Foundry resource in a region that offers gpt-image-2.5
(September 2026: swedencentral, polandcentral, eastus2, westus3, uaenorth; GlobalStandard
only). With the default deployment names nothing else needs configuring:

```bash
az cognitiveservices account deployment create -n <resource> -g <rg> --deployment-name gpt-image-2.5-flare --model-name gpt-image-2.5-flare --model-version 2026-09-08 --model-format OpenAI --sku-name GlobalStandard --sku-capacity 10
```

```bash
az cognitiveservices account deployment create -n <resource> -g <rg> --deployment-name gpt-image-2.5-sunburst --model-name gpt-image-2.5-sunburst --model-version 2026-09-08 --model-format OpenAI --sku-name GlobalStandard --sku-capacity 10
```

## Configure (once)

The server reads its settings from environment variables. Simplest: an **env file** at
`~/.claude/foundry-image.env` (or any path in `FOUNDRY_IMAGE_ENV_FILE`), plain `KEY=VALUE`
lines, `#` comments allowed:

```
GPT_IMAGE_ENDPOINT=https://<resource>.services.ai.azure.com
GPT_IMAGE_API_KEY=<key>
IMAGE_OUTPUT_DIR=C:/Users/<you>/Pictures/ai
```

The file is read when the server starts; a variable that is already set (non-empty) in
the process environment wins over the file, so OS env vars and `settings.json → env` keep
working and can override single values. Restart Claude Code after editing it.

| Variable | Required | Meaning |
|---|---|---|
| `GPT_IMAGE_ENDPOINT` | yes | Resource base URL (`https://<resource>.services.ai.azure.com` or `.openai.azure.com`) |
| `GPT_IMAGE_API_KEY` | yes | Resource key |
| `GPT_IMAGE_FLARE_DEPLOYMENT` | no | Deployment behind `flare_image`; default `gpt-image-2.5-flare` |
| `GPT_IMAGE_SUNBURST_DEPLOYMENT` | no | Deployment behind `sunburst_image`; default `gpt-image-2.5-sunburst` |
| `IMAGE_OUTPUT_DIR` | no | Default output folder; falls back to the OS temp dir |
| `FOUNDRY_IMAGE_ENV_FILE` | no | Path of the env file; default `~/.claude/foundry-image.env` |

Then, in any session: *"run check_config"* or `/foundry-image:setup` for a guided pass.

## Use

Just ask: *"maak een hero image voor de README, donker, isometrisch, geen tekst"*.
Claude picks the model, expands the prompt, picks a size, writes the PNG (into the repo
when it belongs there) and returns the path.

Parameters (same for both image tools):

| Param | Meaning |
|---|---|
| `prompt` (req) | Full description when generating; only the change when editing |
| `image` | Path to a PNG/JPEG to edit. Omit to generate. The source is never modified. |
| `size` | `WIDTHxHEIGHT` or `auto`. Default `1024x1024`; edits default to the input's own size |
| `quality` | `low`, `medium` (default), `high`, `xhigh`, `max`, `auto` |
| `output_path` | Where to write the `.png`; default a timestamped file in `IMAGE_OUTPUT_DIR` |

Size rules: both sides divisible by 16, aspect ratio 1:3 to 3:1, no side above 3840 px,
655,360–8,294,400 pixels in total (above 2560x1440 is experimental). So `1024x1024`,
`1536x864`, `2048x1152`, `3840x2160` work; `768x768` (too few pixels) and `1000x1000`
(not divisible by 16) do not.

Quality drives cost and time: at 1024x1024, `low` is about 200 output tokens, `xhigh`
about 3,100 and `max` about 7,000 (roughly a minute).

## Upgrading from 1.x

2.0 drops the MAI backend and the `generate_image` / `edit_image` tools with their `model`
argument. `MAI_IMAGE_*`, `GPT_IMAGE_DEPLOYMENT`, `GPT_IMAGE_API_VERSION` and
`IMAGE_DEFAULT_MODEL` are no longer read; `MAI_IMAGE_OUTPUT_DIR` is now `IMAGE_OUTPUT_DIR`,
and `GPT_IMAGE_API_KEY` is required (it no longer falls back to the MAI key).

## Why env vars and not a config file or setup dialog?

Claude Code plugins have no per-plugin secret storage or setup UI. The convention —
same one the official GitHub plugin uses for its PAT — is `${VAR}` expansion in the
plugin's `.mcp.json`, with the user setting the variables once.

If you want the key out of plaintext files, load it into the environment from a secret
store at login (Key Vault, 1Password CLI, Windows Credential Manager) — the server does
not care where the variable comes from.

## Develop

```bash
npm test
```

Runs an offline smoke test: MCP handshake, tool listing, size and quality guards,
missing-config errors, env-file handling, and checks that `check_config` never leaks a key.

## License

MIT
