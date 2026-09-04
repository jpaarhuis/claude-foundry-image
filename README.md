# claude-foundry-image

Claude Code plugin that gives every project and every conversation an image generator
backed by your own Azure AI Foundry deployments: the MAI image API (e.g. `MAI-Image-2.5-Pro`)
and/or `gpt-image-2` through the OpenAI-compatible Azure API. Pick the backend per call with
`model: "mai" | "gpt-image"`.

- **MCP server** (`server/server.mjs`) — Node ≥ 18, zero dependencies. Tools:
  `generate_image`, `edit_image`, `check_config`.
- **Skill `generate-image`** — teaches Claude when to reach for the tools, how to expand
  a one-liner into a usable prompt, valid dimensions, where to write files.
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

## Configure (once)

The server reads its settings from environment variables. Put them in
`~/.claude/settings.json` under `env` — one file, all platforms, only Claude Code sees it:

```json
{
  "env": {
    "MAI_IMAGE_ENDPOINT": "https://<resource>.services.ai.azure.com/mai/v1/images/generations",
    "MAI_IMAGE_DEPLOYMENT": "MAI-Image-2.5-Pro",
    "MAI_IMAGE_API_KEY": "<key>",
    "MAI_IMAGE_OUTPUT_DIR": "C:/Users/<you>/Pictures/ai",
    "GPT_IMAGE_ENDPOINT": "https://<resource>.services.ai.azure.com",
    "GPT_IMAGE_DEPLOYMENT": "gpt-image-2"
  }
}
```

Either backend alone is enough; configure both to switch per call. `GPT_IMAGE_API_KEY` is
only needed when gpt-image lives on a different resource than the MAI deployment.

Or set them as OS user environment variables (`setx` on Windows, `export` in your shell
profile on macOS/Linux). Restart Claude Code either way.

Then, in any session: *"run check_config"* or `/foundry-image:setup` for a guided pass.

| Variable | Required | Meaning |
|---|---|---|
| `MAI_IMAGE_ENDPOINT` | yes | Full URL ending in `/mai/v1/images/generations` |
| `MAI_IMAGE_DEPLOYMENT` | yes | Deployment name in Foundry |
| `MAI_IMAGE_API_KEY` | yes | Resource key |
| `MAI_IMAGE_OUTPUT_DIR` | no | Default output folder; falls back to the OS temp dir |
| `GPT_IMAGE_ENDPOINT` | for gpt-image | Resource base URL (`https://<resource>.services.ai.azure.com` or `.openai.azure.com`); a full `/openai/deployments/<name>/images/generations` URL also works |
| `GPT_IMAGE_DEPLOYMENT` | for gpt-image | Deployment name, e.g. `gpt-image-2` |
| `GPT_IMAGE_API_KEY` | no | Key for the gpt-image resource; defaults to `MAI_IMAGE_API_KEY` |
| `GPT_IMAGE_API_VERSION` | no | Default `2025-04-01-preview` |
| `IMAGE_DEFAULT_MODEL` | no | `mai` (default) or `gpt-image`: backend used when a call passes no `model` |

## Use

Just ask: *"maak een hero image voor de README, donker, isometrisch, geen tekst"*.
Claude expands the prompt, picks dimensions, writes the PNG (into the repo when it
belongs there) and returns the path.

Tool parameters, for reference:

| Tool | Params |
|---|---|
| `generate_image` | `prompt` (req), `width`, `height` (default 1024×1024), `output_path` (`.png`) |
| `edit_image` | `image` (req, PNG/JPEG path), `prompt` (req), `output_path` |
| `check_config` | — |

Dimension rules from the MAI API: each side ≥ 768 px and width × height ≤ 1 048 576 px.
With `model: "gpt-image"` the width/height only pick the aspect ratio; the API renders
`1536x1024`, `1024x1536` or `1024x1024` (or pass `size` directly) at `quality` low/medium/high.
So `1024x1024`, `1024x768`, `1280x800` work; `1024x1536` and `1920x1080` do not.

## Why env vars and not a config file or setup dialog?

Claude Code plugins have no per-plugin secret storage or setup UI. The convention —
same one the official GitHub plugin uses for its PAT — is `${VAR}` expansion in the
plugin's `.mcp.json`, with the user setting the variables once. `settings.json → env`
is the least-friction place for that: it travels with your Claude Code profile, applies
to every project, and survives plugin updates.

If you want the key out of plaintext files, load it into the environment from a secret
store at login (Key Vault, 1Password CLI, Windows Credential Manager) — the server does
not care where the variable comes from.

## Develop

```bash
npm test
```

Runs an offline smoke test: MCP handshake, tool listing, dimension guards, missing-config
errors, and checks that `check_config` never leaks a key.

## License

MIT
