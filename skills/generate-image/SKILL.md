---
name: generate-image
description: Generate or edit images with the Azure AI Foundry image model via the foundry-image MCP tools. Use whenever the user asks for a picture, illustration, icon, logo concept, hero image, thumbnail, diagram-as-art, mockup background, or wants an existing PNG/JPEG changed ("make the sky darker", "remove the text"). Also use when the user says "genereer een plaatje", "maak een afbeelding", "teken", or asks to visualise something as an image rather than a chart or diagram.
---

# Generate images with foundry-image

Tools (names carry the plugin prefix, e.g. `mcp__plugin_foundry-image_foundry-image__generate_image`):

| Tool | Purpose |
|---|---|
| `generate_image` | Text prompt → PNG on disk. Returns the path. |
| `edit_image` | Existing PNG/JPEG + instruction → new PNG on disk. Source untouched. |
| `check_config` | Reports which env vars are set. Never shows the key. |

Images never enter the conversation as base64. The tool writes a file and returns its
absolute path. Show the user the path; if a viewer is available (Read tool on the PNG,
SendUserFile, or an artifact), open it so they can see the result.

## Workflow

1. **Turn the request into a full prompt.** Users write "a cat on a laptop". Expand to
   subject, setting, style, composition, lighting, colour palette, mood, and what to avoid.
   Keep it one paragraph. Do not ask the user to write this themselves.
2. **Pick the backend and dimensions.** `model: "mai"` (default) or `model: "gpt-image"`
   (gpt-image-2: stronger prompt adherence and complex scenes; use it when the user
   asks for gpt-image, when a skill prescribes it, or when MAI output misses details).
   - MAI: each side ≥ 768 px, width × height ≤ 1 048 576 px. Valid: `1024x1024`
     (default), `1024x768`, `768x1024`, `1280x800`, `800x1280`. Invalid: `1024x1536`,
     `1920x1080`. For a wide banner use `1280x800` and tell the user to crop.
   - gpt-image: any width/height with both sides divisible by 16 is rendered as-is
     (`2048x1152` for 16:9, `1024x1024`, `1536x1024` ...); other values fall back to the
     nearest classic size. Pass `quality` `low` for drafts, `medium` (default) for most
     work, `high` for final deliverables. Edits keep the input aspect (`size` auto) and
     faces (`input_fidelity` high): send a finished image plus one short instruction.
3. **Choose the output path.** If the user is inside a project and the image belongs to
   it (README asset, app icon, docs figure), write into the repo with a descriptive name
   (`docs/img/hero-dark.png`). Otherwise omit `output_path` and let it fall back to
   `MAI_IMAGE_OUTPUT_DIR`. Always `.png`.
4. **Call the tool.** One call per image. For variations, call again with a changed
   prompt rather than asking for `n` — the API returns one image per request.
5. **Report.** Give the path, one line on what was rendered, and offer one concrete
   follow-up (different style, aspect ratio, or an edit).

## Editing

Use `edit_image` when the user has a file and wants a change. Pass the source path and
an instruction that says *what to change*, not a full re-description of the scene:
"replace the background with a plain white studio backdrop", "make the jacket red".
Default output is a new timestamped file; set `output_path` if they want it next to the
source.

## Prompt craft

- Lead with the subject and the medium: "Flat vector illustration of …", "Photorealistic
  product shot of …", "Watercolour …", "Isometric 3D render of …".
- Name the composition: close-up, wide shot, centered, rule of thirds, negative space on
  the left for text.
- Name the light: soft diffuse daylight, dramatic rim light, golden hour, studio softbox.
- Name colours as a palette (2–4 colours) or a reference mood ("muted Scandinavian
  pastels").
- For UI/marketing assets say "no text" unless text is wanted; image models garble type.
- For icons/logos: "single centered symbol, flat, solid background, no gradients, no
  shadow, no text".
- For transparent-looking assets: request "on a plain #FFFFFF background" and let the
  user key it out; the MAI endpoint returns opaque PNGs.

## Errors

- `MAI_IMAGE_* is not configured` / `GPT_IMAGE_* is not configured` → run `check_config`,
  then point the user to the `setup` skill (`/foundry-image:setup`). Do not ask them to
  paste the API key in chat. If only the other backend is configured, use that one.
- `exceeds the MAI limit` → adjust dimensions per step 2.
- `HTTP 401/403` → wrong key or key for another resource; `HTTP 404` → endpoint path or
  deployment name wrong. Report the exact message and suggest `check_config`.
- `HTTP 429` → rate limited; wait a few seconds and retry once.
