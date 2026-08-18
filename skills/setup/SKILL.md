---
name: setup
description: One-time configuration of the foundry-image plugin — set the Azure AI Foundry endpoint, deployment name and API key so the generate_image / edit_image tools work in every project. Use when the user installs the plugin, when check_config reports missing variables, when image generation fails with "is not configured", or when the user asks to "set up foundry-image", "configure image generation", or "change the image endpoint/key".
---

# foundry-image setup

The MCP server reads four environment variables. They must be visible to the Claude
Code process that spawns the plugin's server. Set them **once**; every project and every
conversation then has image generation.

| Variable | Required | Value |
|---|---|---|
| `MAI_IMAGE_ENDPOINT` | yes | Full generation URL: `https://<resource>.services.ai.azure.com/mai/v1/images/generations` |
| `MAI_IMAGE_DEPLOYMENT` | yes | Deployment name as shown in Foundry (e.g. `MAI-Image-2.5-Pro`) |
| `MAI_IMAGE_API_KEY` | yes | Key 1 or Key 2 of the Foundry resource |
| `MAI_IMAGE_OUTPUT_DIR` | no | Folder for images when no `output_path` is given. Default: OS temp dir |

## Where to put them (pick one)

**Recommended: `~/.claude/settings.json` → `env`.** One file, works on every OS, only
affects Claude Code, survives plugin updates.

```json
{
  "env": {
    "MAI_IMAGE_ENDPOINT": "https://<resource>.services.ai.azure.com/mai/v1/images/generations",
    "MAI_IMAGE_DEPLOYMENT": "<deployment-name>",
    "MAI_IMAGE_API_KEY": "<key>",
    "MAI_IMAGE_OUTPUT_DIR": "C:/Users/<you>/Pictures/ai"
  }
}
```

Merge into the existing `env` object if there is one. The key is stored in plaintext in
that file, same as any local MCP credential; keep the file out of sync/backup tools that
you would not trust with a secret.

**Alternative: OS user environment.** Also reachable by other tools on the machine.

- Windows: `setx MAI_IMAGE_ENDPOINT "https://…/mai/v1/images/generations"` (repeat per
  variable), then open a new terminal.
- macOS/Linux: `export MAI_IMAGE_…=…` in `~/.zshrc` / `~/.bashrc`, or `launchctl setenv`
  on macOS for GUI-launched apps.

Restart Claude Code afterwards — env and MCP config are read at startup.

## Procedure for Claude

1. Call `check_config`. If it says `Configuration OK.`, stop; nothing to do.
2. Ask the user for **endpoint** and **deployment** (not secret; `AskUserQuestion` is
   fine). Ask which storage they prefer: `settings.json` or OS env.
3. **Never ask the user to paste the API key into the chat.** Instead:
   - settings.json route: write the `env` block with endpoint, deployment, output dir,
     and the literal placeholder `"MAI_IMAGE_API_KEY": "<paste-key-here>"`; then tell the
     user to open the file and replace the placeholder themselves.
   - OS env route: give them the `setx` / `export` command for the key to run
     themselves, and run the non-secret ones for them if they agree.
   If the key already lives in a secret store they control (Azure Container App secret,
   Key Vault, password manager), give a one-liner that pipes it into the env var without
   printing it, e.g. on Windows:
   `powershell -Command "$k = az keyvault secret show --vault-name <v> --name <n> --query value -o tsv; [Environment]::SetEnvironmentVariable('MAI_IMAGE_API_KEY', $k, 'User')"`.
4. Tell the user to restart Claude Code, then run `check_config` again and do one
   `generate_image` with a short prompt to prove the pipeline end-to-end.

## Finding the values in Azure

- Endpoint + key: Azure portal → the AI Foundry / AI Services resource → *Keys and
  Endpoint*. The endpoint shown there is the base URL; append
  `/mai/v1/images/generations`.
- Deployment name: Foundry portal → *Deployments* → the image model → *Name*.
