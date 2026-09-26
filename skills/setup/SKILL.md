---
name: setup
description: One-time configuration of the foundry-image plugin — set the Azure AI Foundry endpoint and API key (and optionally the flare/sunburst deployment names) so the flare_image / sunburst_image tools work in every project. Use when the user installs the plugin, when check_config reports missing variables, when image generation fails with "is not configured", or when the user asks to "set up foundry-image", "configure image generation", or "change the image endpoint/key".
---

# foundry-image setup

The MCP server needs one Azure AI Foundry resource with two deployments:
`gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`. It reads these environment variables:

| Variable | Required | Value |
|---|---|---|
| `GPT_IMAGE_ENDPOINT` | yes | Resource base URL: `https://<resource>.services.ai.azure.com` (or `.openai.azure.com`) |
| `GPT_IMAGE_API_KEY` | yes | Key 1 or Key 2 of that resource |
| `GPT_IMAGE_FLARE_DEPLOYMENT` | no | Deployment name behind `flare_image`; default `gpt-image-2.5-flare` |
| `GPT_IMAGE_SUNBURST_DEPLOYMENT` | no | Deployment name behind `sunburst_image`; default `gpt-image-2.5-sunburst` |
| `IMAGE_OUTPUT_DIR` | no | Folder for images when no `output_path` is given. Default: OS temp dir |
| `FOUNDRY_IMAGE_ENV_FILE` | no | Path of the env file; default `~/.claude/foundry-image.env` |

## Where to put them (pick one)

**Recommended: the env file `~/.claude/foundry-image.env`.** Plain `KEY=VALUE` lines,
`#` comments, quotes optional. Read once at server start; anything already set in the
process environment (OS env, `settings.json` env) wins over the file. Survives plugin
updates, is outside every repo, and `check_config` prints whether it was found.

```
GPT_IMAGE_ENDPOINT=https://<resource>.services.ai.azure.com
GPT_IMAGE_API_KEY=<paste-key-here>
IMAGE_OUTPUT_DIR=C:/Users/<you>/Pictures/ai
```

**Alternative: `~/.claude/settings.json` → `env`.** One file, works on every OS, only
affects Claude Code, survives plugin updates. Merge into the existing `env` object. The
key is stored in plaintext; keep the file out of sync/backup tools you would not trust
with a secret.

**Alternative: OS user environment.** Also reachable by other tools on the machine.
Windows: `setx GPT_IMAGE_ENDPOINT "https://…"`; macOS/Linux: `export` in the shell profile.

Restart Claude Code afterwards — env and MCP config are read at startup.

## Procedure for Claude

1. Call `check_config`. If it says `Configuration OK.`, stop; nothing to do.
2. Ask the user which Foundry resource to use (not secret; `AskUserQuestion` is fine) and
   check the deployments exist:
   `az cognitiveservices account deployment list -n <resource> -g <rg> -o table`.
   Missing ones can be created (region must offer gpt-image-2.5, e.g. swedencentral,
   polandcentral, eastus2, westus3, uaenorth; GlobalStandard only):
   `az cognitiveservices account deployment create -n <resource> -g <rg> --deployment-name gpt-image-2.5-flare --model-name gpt-image-2.5-flare --model-version 2026-09-08 --model-format OpenAI --sku-name GlobalStandard --sku-capacity 10`
   (same for `gpt-image-2.5-sunburst`). Confirm with the user before creating.
3. **Never ask the user to paste the API key into the chat.** Write the env file with the
   non-secret values and the literal placeholder `GPT_IMAGE_API_KEY=<paste-key-here>`,
   then either tell the user to replace it, or give a one-liner that pipes the key from
   `az` into the file without printing it, e.g. on Windows PowerShell:
   `$f = "$HOME/.claude/foundry-image.env"; $k = az cognitiveservices account keys list -n <resource> -g <rg> --query key1 -o tsv; (Get-Content $f) -replace '^GPT_IMAGE_API_KEY=.*', "GPT_IMAGE_API_KEY=$k" | Set-Content $f`
4. Tell the user to restart Claude Code, then run `check_config` again and do one
   `flare_image` call with a short prompt at `quality: low` to prove the pipeline.

## Finding the values in Azure

- Endpoint + key: Azure portal → the AI Foundry / AI Services resource → *Keys and
  Endpoint*. Use the base URL without any path.
- Deployment names: Foundry portal → *Deployments*, or the `az … deployment list` above.
- Region availability: `az cognitiveservices model list --location <region> --query "[?contains(model.name,'gpt-image')].model.name" -o tsv`.
