---
name: generate-image
description: Generate or edit images with gpt-image-2.5 (flare or sunburst) on Azure AI Foundry via the foundry-image MCP tools. Use whenever the user asks for a picture, illustration, icon, logo concept, hero image, thumbnail, diagram-as-art, mockup background, or wants an existing PNG/JPEG changed ("make the sky darker", "remove the text"). Also use when the user says "genereer een plaatje", "maak een afbeelding", "teken", or asks to visualise something as an image rather than a chart or diagram.
---

# Generate images with foundry-image

Tools (names carry the plugin prefix, e.g. `mcp__plugin_foundry-image_foundry-image__flare_image`):

| Tool | Model | Use for |
|---|---|---|
| `flare_image` | gpt-image-2.5-flare | **Default.** Fast (about 15–25 s at low/medium). Blog and social visuals, thumbnails, illustrations, icons, drafts, variations, quick edits. |
| `sunburst_image` | gpt-image-2.5-sunburst | Most detail and most precise edits, noticeably slower. Final deliverables (campaign visuals, product shots, hero images, dense scenes) and edits that must change one thing and keep the rest. |
| `check_config` | — | Reports endpoint, deployments and output dir. Never shows the key. |

Both image tools generate from a prompt, or **edit** when you pass `image` (a PNG/JPEG
path). Images never enter the conversation as base64: the tool writes a file and returns
its absolute path. Show the user the path; if a viewer is available (Read tool on the PNG,
SendUserFile, or an artifact), open it so they can see the result.

## Picking the model

- Start with `flare_image` unless one of the next points applies.
- Use `sunburst_image` when the user asks for the best possible result, for a final
  asset after flare drafts, when an image has lots of small detail, or when an edit
  must leave everything outside the change untouched.
- A good pattern for important images: explore 2–3 directions with flare at `low` or
  `medium`, then render the chosen one with sunburst at `high`.
- If the user names a model ("doe maar sunburst"), use that one.

## Workflow

1. **Turn the request into a full prompt.** Users write "a cat on a laptop". Expand to
   subject, setting, style, composition, lighting, colour palette, mood, and what to avoid.
   Keep it one paragraph. Do not ask the user to write this themselves.
2. **Pick the size.** `WIDTHxHEIGHT`, both sides divisible by 16, aspect ratio between
   1:3 and 3:1, no side above 3840, 655,360–8,294,400 pixels in total. Common choices:
   `1024x1024` (default), `1536x864` (16:9), `864x1536` (9:16), `1536x1024` (3:2),
   `2048x1152` (large 16:9), `3840x2160` (4K, experimental above 2560x1440).
   Too small is rejected: `640x640` and `768x768` fall below the pixel minimum.
   `auto` lets the model choose.
3. **Pick the quality.** `low` for drafts, `medium` (default) for most work, `high` for
   finished assets, `xhigh`/`max` only when asked; they cost a lot more. At 1024x1024,
   `low` is about 200 output tokens, `xhigh` about 3,100 and `max` about 7,000, and
   `max` takes about a minute.
4. **Choose the output path.** If the user is inside a project and the image belongs to
   it (README asset, app icon, docs figure), write into the repo with a descriptive name
   (`docs/img/hero-dark.png`). Otherwise omit `output_path` and let it fall back to
   `IMAGE_OUTPUT_DIR`. Always `.png`.
5. **Call the tool.** One call per image. For variations, call again with a changed prompt.
6. **Report.** Give the path, one line on what was rendered, and offer one concrete
   follow-up (different style, aspect ratio, an edit, or a sunburst render of a flare draft).

## Editing

Pass `image` plus an instruction that says *what to change*, not a full re-description
of the scene: "replace the background with a plain white studio backdrop", "make the
jacket red", "add a small sailboat on the horizon, change nothing else". Without `size`
the result keeps the input's dimensions. Default output is a new timestamped file; set
`output_path` if the user wants it next to the source. For several edit rounds on one
image, feed each result back in as the next `image`.

## Prompt craft

- Lead with the subject and the medium: "Flat vector illustration of …", "Photorealistic
  product shot of …", "Watercolour …", "Isometric 3D render of …".
- Name the composition: close-up, wide shot, centered, rule of thirds, negative space on
  the left for text.
- Name the light: soft diffuse daylight, dramatic rim light, golden hour, studio softbox.
- Name colours as a palette (2–4 colours) or a reference mood ("muted Scandinavian
  pastels").
- For UI/marketing assets say "no text" unless text is wanted.
- For icons/logos: "single centered symbol, flat, solid background, no gradients, no
  shadow, no text".
- For transparent-looking assets: request "on a plain #FFFFFF background" and let the
  user key it out; the API returns opaque PNGs.

## Errors

- `GPT_IMAGE_* is not configured` → run `check_config`, then point the user to the
  `setup` skill (`/foundry-image:setup`). Do not ask them to paste the API key in chat.
- `size … is invalid` → the message lists the broken rule; pick a size from step 2.
- `HTTP 401/403` → wrong key or key for another resource; `HTTP 404` → endpoint or
  deployment name wrong. Report the exact message and suggest `check_config`.
- `HTTP 429` → rate limited; wait a few seconds and retry once.
