# Tripo AI MCP Server

A Model Context Protocol (MCP) server for the [Tripo3D](https://www.tripo3d.ai/) API. It lets AI assistants generate, process, rig and animate 3D models.

It targets **Tripo API v3** (`https://openapi.tripo3d.ai/v3`). Tripo is retiring API v2: it stops receiving updates on 2026-10-01 and shuts down on 2026-11-01. Versions of this server before 2.0.0 use v2 and will stop working then.

## Features

- **3D generation**: text, a single image, or 2–4 views to a 3D model, with the H series (`v3.1`, `v3.0`, `v2.5`) and the low-poly P series (`P1`, `P2`). Also image to Gaussian Splat.
- **Image generation**: text to image, image to image, image to multiview, and edit multiview. Useful for preparing clean references.
- **Model processing**: retexture, convert format, import external models, and stylize.
- **Mesh operations**: segmentation, smart segmentation, part completion, and retopology.
- **Animation**: riggability check, auto-rig (humanoid and non-humanoid), and preset animation retargeting.
- **Tasks and account**: status and batch status, wait-until-done, download outputs to disk, file upload, credit balance and usage.
- **Flexible inputs**: anywhere an image or model is expected you can pass a local file path (uploaded automatically, via a presigned URL for large files), a public URL, a `file_…` token, or the task ID of an earlier task.
- **Dry runs**: every paid tool accepts `dry_run: true`, which returns the exact request body without uploading anything or spending credits.

## Installation

The server is not published to a package registry yet, so install it from GitHub. Requires Node.js 18 or later and git.

```bash
git clone https://github.com/ebrob/tripo3d-mcp-server.git
cd tripo3d-mcp-server
npm install
npm run build
```

This builds the server to `dist/index.js`. Note the absolute path to that file (run `echo "$PWD/dist/index.js"` from the repo folder). The client configuration below needs it.

To update later, run `git pull`, `npm install` and `npm run build` in the same folder, then restart your MCP client.

## Configuration

Create an API key in the [Tripo API console](https://platform.tripo3d.ai/). API credits are separate from a Tripo Studio subscription. Provide the key as `TRIPO_API_KEY`, in the environment or in a `.env` file in the directory the server runs from. For MCP clients, setting it in the client's `env` block (below) is the most reliable. `TRIPO_API_SECRET` still works as a fallback.

Optional: `TRIPO_API_BASE_URL` overrides the base URL, for example to use a regional endpoint.

### Claude Desktop / Claude Code

Add to `claude_desktop_config.json` or a project `.mcp.json`:

```json
{
  "mcpServers": {
    "tripo3d": {
      "command": "node",
      "args": ["/absolute/path/to/tripo3d-mcp-server/dist/index.js"],
      "env": {
        "TRIPO_API_KEY": "your_api_key_here"
      }
    }
  }
}
```

## Tools

Tools marked 💳 consume credits. All tasks are asynchronous: a task tool returns a `task_id`. Follow it with `wait_for_task` or `get_task_status`, then save the files with `download_task_output`. Tripo does not charge for failed or cancelled tasks.

### 3D generation

| Tool | Description |
| --- | --- |
| `text_to_3d` 💳 | Text prompt to 3D model. |
| `image_to_3d` 💳 | One image to 3D model. |
| `multiview_to_3d` 💳 | `front` (required) plus `left`/`back`/`right` views, or a `multiview_task_id`, to 3D model. |
| `image_to_splat` 💳 | One image to a `.splat` Gaussian Splat. |

These share the generation options: `model` (default `v3.1-20260211`), `face_limit`, `texture`, `pbr`, `texture_quality` (`fast`/`standard`/`detailed`/`extreme`), `texture_version` (including the new `v3.5-20260815`), `delight`, `geometry_quality`, `quad`, `smart_low_poly`, `generate_parts`, `auto_size`, `compress`, seeds, `export_uv` and `export_orientation`. Leave the options unset to get the base price. `detailed`/`extreme` texture, `detailed` geometry, `quad`, `smart_low_poly` and `generate_parts` are paid add-ons. `face_limit` is not.

### Image generation

| Tool | Description |
| --- | --- |
| `text_to_image` 💳 | Text to image (seedream, banana, chat_image models). |
| `image_to_image` 💳 | Edit, restyle or combine 1–16 reference images. |
| `image_to_multiview` 💳 | One image to front/left/back/right views. |
| `edit_multiview` 💳 | Per-view edits to a multiview set. |

### Model processing and mesh operations

| Tool | Description |
| --- | --- |
| `texture_model` 💳 | Retexture a model, optionally guided by text, a style image, or 1 or 4 reference images. |
| `convert_model` 💳 | Export as GLTF, FBX, OBJ, STL, USDZ or 3MF, with retopology, texture, pivot, scale and orientation options. |
| `import_model` | Bring an external GLB/GLTF/FBX/OBJ/STL into Tripo for other tools. |
| `stylize_model` 💳 | Lego, voxel, voronoi or minecraft style. |
| `segment_mesh` 💳 | Split a model into parts. |
| `smart_segment` 💳 | End-to-end segmentation from an image or a GLB. |
| `complete_mesh` 💳 | Fill in segmented parts. |
| `retopologize_mesh` 💳 | Reduce polycount. |

### Animation

| Tool | Description |
| --- | --- |
| `animate_prerigcheck` | Is the model riggable, and with which rig type? Free. |
| `rig_model` 💳 | Add a skeleton (`v1.0-20240301` humanoid; `v2.5-20260210` creatures). |
| `retarget_animation` 💳 | Apply one or more preset animations to a rigged model. |

### Tasks, files and account (free)

| Tool | Description |
| --- | --- |
| `get_task_status` | Status, progress, outputs and credits consumed for a task. |
| `get_tasks` | Status of up to 100 tasks at once. |
| `wait_for_task` | Poll until a task finishes (default 50 s, under common client timeouts; call again to keep waiting). |
| `download_task_output` | Save all output files to a folder as `<name>.glb`, `<name>-preview.png`, and so on. |
| `upload_file` | Upload a local image or model and get a reusable `file_token`. |
| `get_balance` | Available and frozen credits. |
| `get_usage` | Recent tasks and the credits each consumed. |

## Upgrading from 1.x

Version 2.0.0 moves to Tripo API v3, and some tool arguments changed:

- `model_version` is now `model`. Only the versions Tripo still accepts are listed; Turbo, v2.0 and v1.4 are gone.
- Image and model inputs are a single `input` string (path, URL, token or task ID). This replaces `image_path` / `image_url` / `image_token` and `original_model_task_id`.
- `multiview_to_3d` takes named `front`/`left`/`back`/`right` views instead of a `files` array.
- `texture_model` uses `input`, `model`, `text_prompt`, `style_image`, `image_prompt` and `image_prompts`.
- `retarget_animation` takes an `animations` array.
- `refine_model` was removed: it only applied to the retired v1.4 draft models.
- Task IDs are UUIDs, and results use v3 field names such as `output.model_url`, `credits_consumed` and `created_at`.

## Development

1. Clone the repo and install dependencies as in [Installation](#installation).
2. After editing `src/`, run `npm run build` again.
3. Run the server directly with `TRIPO_API_KEY=… node dist/index.js`.

## License

ISC
