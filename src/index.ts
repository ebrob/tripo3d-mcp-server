#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { TripoApi, TripoApiError, sniffExtension } from './api.js';
import { expandPath, resolveInput, resolveInputObject } from './inputs.js';
import {
  DEFAULT_3D_MODEL,
  IMAGE_MODELS,
  RIG_TYPES,
  dryRun,
  generationOptions,
  imageGenerationOptions,
  sourceDescription,
} from './schemas.js';
import { TERMINAL_STATUSES, TripoTask } from './types.js';

dotenv.config({ quiet: true });

const api = new TripoApi();

const server = new McpServer({
  name: 'tripo-ai-mcp-server',
  version: '2.0.0',
});

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  let text: string;
  if (error instanceof TripoApiError) {
    text = `Tripo API error ${error.code ?? ''} (HTTP ${error.httpStatus}): ${error.message}`;
    if (error.suggestion) text += `\nSuggestion: ${error.suggestion}`;
    if (error.requestId) text += `\nRequest ID: ${error.requestId}`;
  } else {
    text = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  return { content: [{ type: 'text', text }], isError: true };
}

// Drops undefined fields so the API applies its own defaults.
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined));
}

// Creates a task, or with dry_run returns the request body instead.
async function submit(route: string, body: Record<string, unknown>, isDryRun?: boolean): Promise<ToolResult> {
  const payload = compact(body);
  if (isDryRun) {
    return ok({ dry_run: true, request: `POST ${route}`, body: payload, note: 'Nothing was uploaded or charged.' });
  }
  const { task_id } = await api.createTask(route, payload);
  return ok({ task_id, next: 'Use wait_for_task or get_task_status to follow progress, then download_task_output to save the results.' });
}

const PAID = 'Consumes Tripo credits.';

// Registers a tool whose handler errors are returned as MCP tool errors.
function tool<Shape extends z.ZodRawShape>(
  name: string,
  description: string,
  inputSchema: Shape,
  handler: (args: z.infer<z.ZodObject<Shape>>, extra: any) => Promise<ToolResult>,
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean } = {},
) {
  server.registerTool(
    name,
    { description, inputSchema, annotations: { openWorldHint: true, ...annotations } },
    (async (args: any, extra: any) => {
      try {
        return await handler(args, extra);
      } catch (error) {
        return fail(error);
      }
    }) as any,
  );
}

// ---------------------------------------------------------------------------
// 3D generation
// ---------------------------------------------------------------------------

tool(
  'text_to_3d',
  `Generate a 3D model from a text description. ${PAID}`,
  {
    prompt: z.string().max(1024).describe('Description of the model: shape, material, style and scale (max 1024 characters).'),
    negative_prompt: z.string().max(255).optional().describe('What to avoid (max 255 characters).'),
    image_seed: z.number().int().optional().describe('Seed for the internal text-to-image stage.'),
    ...generationOptions,
    dry_run: dryRun,
  },
  async ({ dry_run, model, ...rest }) =>
    submit('/generation/text-to-model', { ...rest, model: model ?? DEFAULT_3D_MODEL }, dry_run),
);

tool(
  'image_to_3d',
  `Generate a 3D model from a single image. ${PAID}`,
  {
    input: z.string().describe(`The image. ${sourceDescription} A task ID must be from text_to_image or image_to_image. PNG, JPEG or WebP, max 20 MB, 256px+ recommended.`),
    enable_image_autofix: z.boolean().optional().describe('Enhance low-quality input images before generation. Default false.'),
    texture_alignment: z.enum(['original_image', 'geometry']).optional().describe('Prioritise matching the input image colours or the geometry. Default "original_image".'),
    orientation: z.enum(['default', 'align_image']).optional().describe('"align_image" aligns the model to the image viewpoint (requires texture). Default "default".'),
    ...generationOptions,
    dry_run: dryRun,
  },
  async ({ dry_run, input, model, ...rest }) =>
    submit('/generation/image-to-model', {
      input: await resolveInput(api, input, dry_run),
      ...rest,
      model: model ?? DEFAULT_3D_MODEL,
    }, dry_run),
);

tool(
  'multiview_to_3d',
  `Generate a 3D model from 2–4 views of the same object (front required), or from the output of an image_to_multiview / edit_multiview task. ${PAID}`,
  {
    front: z.string().optional().describe(`Front view. ${sourceDescription}`),
    left: z.string().optional().describe('Left view (the subject\'s own left side). Same source types as front.'),
    back: z.string().optional().describe('Back view. Same source types as front.'),
    right: z.string().optional().describe('Right view (the subject\'s own right side). Same source types as front.'),
    multiview_task_id: z.string().optional().describe('Instead of individual views: the task ID of a successful image_to_multiview or edit_multiview task.'),
    texture_alignment: z.enum(['original_image', 'geometry']).optional().describe('Default "original_image".'),
    orientation: z.enum(['default', 'align_image']).optional().describe('Default "default".'),
    ...generationOptions,
    dry_run: dryRun,
  },
  async ({ dry_run, front, left, back, right, multiview_task_id, model, ...rest }) => {
    let inputs: Record<string, string>[];
    if (multiview_task_id) {
      if (front || left || back || right) {
        throw new Error('Pass either multiview_task_id or individual views, not both.');
      }
      inputs = [{ task_id: multiview_task_id }];
    } else {
      if (!front) throw new Error('The front view is required.');
      const views = { front, left, back, right };
      inputs = [];
      for (const [view, source] of Object.entries(views)) {
        if (source) inputs.push({ [view]: await resolveInput(api, source, dry_run) });
      }
      if (inputs.length < 2) throw new Error('At least two views are required (front plus one more).');
    }
    return submit('/generation/multiview-to-model', { inputs, ...rest, model: model ?? DEFAULT_3D_MODEL }, dry_run);
  },
);

tool(
  'image_to_splat',
  `Generate a 3D Gaussian Splat (.splat) from a single image, for real-time photorealistic rendering rather than an editable mesh. ${PAID} (30 credits per generation; about 4 minutes.)`,
  {
    input: z.string().describe(`The image. ${sourceDescription}`),
    model_seed: z.number().int().optional().describe('Seed; same seed + input gives an identical result.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) =>
    submit('/generation/image-to-splat', { input: await resolveInput(api, input, dry_run), ...rest }, dry_run),
);

// ---------------------------------------------------------------------------
// Image generation
// ---------------------------------------------------------------------------

tool(
  'text_to_image',
  `Generate an image from text. Useful as a clean reference for image_to_3d (pass the returned task ID as its input). ${PAID}`,
  {
    prompt: z.string().describe('Image description. Put the most important elements first; append negatives after "--no".'),
    model: z.enum(IMAGE_MODELS).optional().describe('Image model. Default "seedream_v4". chat_image_1 retires 2026-10-23 and chat_image_1.5 on 2026-12-01.'),
    template: z.enum(['asset_extraction', 'character_completion', 't_pose', 'variants', 'figure']).optional().describe('Generation template.'),
    watermark: z.boolean().optional().describe('Add an AI-content watermark (seedream only). Default false.'),
    ...imageGenerationOptions,
    dry_run: dryRun,
  },
  async ({ dry_run, ...rest }) => submit('/generation/text-to-image', rest, dry_run),
);

tool(
  'image_to_image',
  `Edit or transform images using reference images (editing, style transfer, multi-image fusion). ${PAID}`,
  {
    images: z.array(z.string()).min(1).max(16).describe(
      `Reference images; refer to them in the prompt as image[1], image[2], … ${sourceDescription} Max 4 for seedream, 10 for banana, 16 for chat_image.`,
    ),
    prompt: z.string().optional().describe('Editing instruction. Required unless a template is set.'),
    model: z.enum(IMAGE_MODELS).exclude(['seedream_v4']).optional().describe('Image model. Default "seedream_v5".'),
    template: z.enum(['t_pose', 'character_completion', '3d_enhance', 'variants', 'figure']).optional().describe('Editing template; makes prompt optional.'),
    ...imageGenerationOptions,
    dry_run: dryRun,
  },
  async ({ dry_run, images, ...rest }) => {
    if (!rest.prompt && !rest.template) throw new Error('Provide a prompt or a template.');
    const resolved = [];
    for (const image of images) resolved.push(await resolveInput(api, image, dry_run));
    const inputField = resolved.length === 1 ? { input: resolved[0] } : { inputs: resolved };
    return submit('/generation/image-to-image', { ...inputField, ...rest }, dry_run);
  },
);

tool(
  'image_to_multiview',
  `Generate front/left/back/right views from a single image, e.g. as input for multiview_to_3d. ${PAID}`,
  {
    input: z.string().describe(`The image. ${sourceDescription}`),
    dry_run: dryRun,
  },
  async ({ dry_run, input }) =>
    submit('/generation/image-to-multiview', { input: await resolveInput(api, input, dry_run) }, dry_run),
);

tool(
  'edit_multiview',
  `Apply edits to specific views of an existing multiview image set. ${PAID}`,
  {
    input: z.string().describe(`The multiview set: usually the task ID of an image_to_multiview task. ${sourceDescription}`),
    edits: z.array(z.object({
      view: z.enum(['front', 'left', 'back', 'right']),
      prompt: z.string().describe('Edit instruction, e.g. "change the shirt colour to red".'),
    })).min(1).describe('Edits, each targeting one view.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, edits }) =>
    submit('/generation/edit-multiview', {
      input: await resolveInput(api, input, dry_run),
      prompts: edits.map(({ prompt, view }) => ({ prompt, view })),
    }, dry_run),
);

// ---------------------------------------------------------------------------
// Model processing
// ---------------------------------------------------------------------------

const modelSource = `The model. ${sourceDescription} Task IDs must be from a 3D generation or processing task. Model files: GLB, GLTF, FBX, OBJ or STL, max 150 MB.`;

tool(
  'texture_model',
  `Generate new textures for an existing 3D model, optionally guided by text or reference images. ${PAID}`,
  {
    input: z.string().describe(modelSource),
    model: z.enum(['v3.5-20260815', 'v3.0-20250812', 'v2.5-20250123']).optional().describe(
      'Texture model. Default "v3.0-20250812" (for v3.x geometry); "v2.5-20250123" for v2.5 geometry; "v3.5-20260815" is newest and required for texture_quality "fast" and delight.',
    ),
    text_prompt: z.string().optional().describe('Text describing the desired texture. Mutually exclusive with image_prompt and image_prompts.'),
    style_image: z.string().optional().describe('Style reference image used alongside text_prompt. Same source types as input.'),
    image_prompt: z.string().optional().describe('A single reference image for the texture. Recommended when retexturing a Tripo task.'),
    image_prompts: z.array(z.string()).length(4).optional().describe('Exactly 4 reference images in order [front, left, back, right].'),
    pbr: z.boolean().optional().describe('Generate PBR materials. Default true.'),
    texture_quality: z.enum(['fast', 'standard', 'detailed', 'extreme']).optional().describe('Default "standard". "fast" needs model v3.5-20260815.'),
    texture_alignment: z.enum(['original_image', 'geometry']).optional().describe('Default "original_image".'),
    texture_seed: z.number().int().optional(),
    part_names: z.array(z.string()).optional().describe('Only texture these parts (from segment_mesh). Default all parts.'),
    compress: z.enum(['geometry']).optional(),
    bake: z.boolean().optional().describe('Bake advanced material effects into base textures. Default true.'),
    delight: z.boolean().optional().describe('Remove baked-in lighting from references. Default true; v3.5 only.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, text_prompt, style_image, image_prompt, image_prompts, ...rest }) => {
    const modes = [text_prompt, image_prompt, image_prompts].filter((v) => v !== undefined).length;
    if (modes > 1) throw new Error('text_prompt, image_prompt and image_prompts are mutually exclusive.');
    if (style_image && !text_prompt) throw new Error('style_image can only be used with text_prompt.');

    let texture_prompt: Record<string, unknown> | undefined;
    if (text_prompt) {
      texture_prompt = { text: text_prompt };
      if (style_image) texture_prompt.style_image = await resolveInputObject(api, style_image, dry_run);
    } else if (image_prompt) {
      texture_prompt = { image: await resolveInput(api, image_prompt, dry_run) };
    } else if (image_prompts) {
      const images = [];
      for (const image of image_prompts) images.push(await resolveInput(api, image, dry_run));
      texture_prompt = { images };
    }
    return submit('/models/texture', { input: await resolveInput(api, input, dry_run), texture_prompt, ...rest }, dry_run);
  },
);

tool(
  'convert_model',
  `Convert a 3D model to another format with optional retopology, texture and export settings. ${PAID}`,
  {
    input: z.string().describe(modelSource),
    format: z.enum(['GLTF', 'USDZ', 'FBX', 'OBJ', 'STL', '3MF']).describe('Target format.'),
    quad: z.boolean().optional().describe('Quad mesh (forces FBX). Default false.'),
    force_symmetry: z.boolean().optional().describe('Force symmetry; only with quad. Default false.'),
    face_limit: z.number().int().positive().optional().describe('Max faces. Default keeps the original count.'),
    flatten_bottom: z.boolean().optional().describe('Default false.'),
    flatten_bottom_threshold: z.number().optional().describe('Flattening depth. Default 0.01.'),
    texture_size: z.number().int().positive().optional().describe('Diffuse texture size in pixels. Default 4096.'),
    texture_format: z.enum(['JPEG', 'PNG', 'WEBP', 'BMP', 'DPX', 'HDR', 'OPEN_EXR', 'TARGA', 'TIFF']).optional().describe('Default "JPEG".'),
    bake: z.boolean().optional().describe('Bake advanced materials into base textures. Default true.'),
    pack_uv: z.boolean().optional().describe('Pack all UVs into one layout. Default false.'),
    export_vertex_colors: z.boolean().optional().describe('OBJ and GLTF only. Default false.'),
    pivot_to_center_bottom: z.boolean().optional().describe('Default false.'),
    scale_factor: z.number().optional().describe('Default 1.'),
    with_animation: z.boolean().optional().describe('Include skeleton and animation. Default true.'),
    animate_in_place: z.boolean().optional().describe('Remove root displacement from animation. Default false.'),
    part_names: z.array(z.string()).optional().describe('Only export these parts (from segment_mesh).'),
    export_orientation: z.enum(['+x', '-x', '+y', '-y']).optional().describe('Forward axis. Default "+x".'),
    fbx_preset: z.enum(['blender', '3dsmax', 'mixamo', 'bake_scale']).optional().describe('FBX only. Default "blender".'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) =>
    submit('/models/convert', { input: await resolveInput(api, input, dry_run), ...rest }, dry_run),
);

tool(
  'import_model',
  'Import an external 3D model file into Tripo so it can be used by other tools (texture, rig, convert, …). Pass the returned task ID onward. Does not accept a task ID as input.',
  {
    input: z.string().describe('A local model file path, a public URL or a file token. GLB, GLTF, FBX, OBJ or STL, max 150 MB.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input }) => submit('/models/import', { input: await resolveInput(api, input, dry_run) }, dry_run),
);

tool(
  'stylize_model',
  `Apply a visual style (lego, voxel, voronoi, minecraft) to an existing 3D model. Not in Tripo's current V3 reference, but the endpoint is live. ${PAID}`,
  {
    input: z.string().describe(modelSource),
    style: z.enum(['lego', 'voxel', 'voronoi', 'minecraft']).describe('Style to apply.'),
    block_size: z.number().int().positive().optional().describe('Block size for lego/voxel/minecraft. Default 80.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) =>
    submit('/models/stylize', { input: await resolveInput(api, input, dry_run), ...rest }, dry_run),
);

// ---------------------------------------------------------------------------
// Mesh operations
// ---------------------------------------------------------------------------

tool(
  'segment_mesh',
  `Split a 3D model into semantic parts. Part names can then be passed to complete_mesh, texture_model, convert_model or retopologize_mesh. ${PAID}`,
  {
    input: z.string().describe(modelSource),
    model: z.enum(['v1.0-20250506', 'v2.0-20260430']).optional().describe('"v1.0-20250506" (default, geometry-based) or "v2.0-20260430" (Beta, semantic labelling).'),
    segmentation_granularity: z.enum(['simple', 'balanced', 'detailed']).optional().describe('v2 only. Default "balanced".'),
    split_by_connectivity: z.boolean().optional().describe('v2 only. Default true.'),
    ref_image: z.string().optional().describe('v2 only. Reference image or segmentation mask for semantic analysis (overrides granularity and connectivity).'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ref_image, ...rest }) =>
    submit('/mesh/segment', {
      input: await resolveInput(api, input, dry_run),
      ref_image: ref_image ? await resolveInput(api, ref_image, dry_run) : undefined,
      ...rest,
    }, dry_run),
);

tool(
  'smart_segment',
  `End-to-end smart segmentation: from an image (also builds the model) or from a GLB model. ${PAID}`,
  {
    seg_type: z.enum(['image', 'model']).describe('"image" for a PNG/JPEG/WebP input; "model" for a GLB input.'),
    input: z.string().describe('A local file path, a public URL or a file token (not a task ID).'),
    granularity: z.enum(['coarse', 'medium', 'fine']).optional().describe('Default "medium".'),
    hint: z.string().optional().describe('Text hint about which parts to separate, e.g. "character with sword and armor".'),
    transform: z.array(z.number()).length(16).optional().describe('Required for seg_type "model": column-major 4×4 matrix. Identity is [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1].'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) => {
    if (rest.seg_type === 'model' && !rest.transform) throw new Error('transform is required when seg_type is "model".');
    return submit('/mesh/smartsegment', { ...rest, input: await resolveInput(api, input, dry_run) }, dry_run);
  },
);

tool(
  'complete_mesh',
  `Complete segmented mesh parts, repairing missing regions. ${PAID}`,
  {
    input: z.string().describe('Task ID of a segment_mesh task.'),
    part_names: z.array(z.string()).optional().describe('Parts to complete. Default all.'),
    completion_mode: z.enum(['ai_completion', 'quick_cap']).optional().describe('"ai_completion" (default) generates missing geometry; "quick_cap" just seals holes.'),
    dry_run: dryRun,
  },
  async ({ dry_run, ...rest }) => submit('/mesh/complete', rest, dry_run),
);

tool(
  'retopologize_mesh',
  `Reduce a model's polycount (high-poly to low-poly retopology). ${PAID}`,
  {
    input: z.string().describe(modelSource),
    face_limit: z.number().int().positive().optional().describe('Target face count.'),
    model: z.enum(['v2.0', 'v1.0']).optional().describe('"v2.0" (default) smart retopology with clean topology; "v1.0" basic decimation.'),
    quad: z.boolean().optional().describe('Output quads. Default false.'),
    bake: z.boolean().optional().describe('Bake textures onto the low-poly model. Default true. Not supported by v1.0.'),
    part_names: z.array(z.string()).optional().describe('Only these parts (from segment_mesh). Not supported by v1.0.'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) =>
    submit('/mesh/decimate', { input: await resolveInput(api, input, dry_run), ...rest }, dry_run),
);

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

tool(
  'animate_prerigcheck',
  'Check whether a model can be rigged and get the recommended rig_type. Free (0 credits). Run before rig_model; the result is in the task output (riggable, rig_type).',
  {
    input: z.string().describe(`The model. ${sourceDescription} Model files must be GLB.`),
    dry_run: dryRun,
  },
  async ({ dry_run, input }) =>
    submit('/animations/rig-check', { input: await resolveInput(api, input, dry_run) }, dry_run),
);

tool(
  'rig_model',
  `Add a skeleton to a 3D model. Use retarget_animation afterwards to apply animations. ${PAID}`,
  {
    input: z.string().describe(modelSource),
    model: z.enum(['v1.0-20240301', 'v2.5-20260210']).optional().describe(
      '"v1.0-20240301" (default): humanoid/biped only, 90+ animation presets. "v2.5-20260210": non-humanoid creatures.',
    ),
    rig_type: z.enum(RIG_TYPES).optional().describe('Skeleton type (see animate_prerigcheck). Default "biped".'),
    spec: z.enum(['tripo', 'mixamo']).optional().describe('Bone naming. Default "tripo".'),
    out_format: z.enum(['glb', 'fbx']).optional().describe('Default "glb".'),
    dry_run: dryRun,
  },
  async ({ dry_run, input, ...rest }) =>
    submit('/animations/rig', { input: await resolveInput(api, input, dry_run), ...rest }, dry_run),
);

tool(
  'retarget_animation',
  `Apply one or more preset animations to a rigged model. ${PAID}`,
  {
    input: z.string().describe('Task ID of the rig_model task.'),
    animations: z.array(z.string()).min(1).describe(
      'Preset IDs. With rig v1.0-20240301 (biped): "preset:biped:<name>", e.g. idle, walk, run, jump, dance_01, wave_goodbye_01, sit, cast_a_spell (90+; see developers.tripo3d.ai/en/docs/animations-retarget). ' +
        'With rig v2.5-20260210: "preset:idle", "preset:walk", "preset:run", "preset:jump", "preset:slash", "preset:shoot", "preset:hurt", "preset:fall", "preset:dive", "preset:climb", "preset:turn", ' +
        '"preset:quadruped:walk", "preset:hexapod:walk", "preset:octopod:walk", "preset:serpentine:march", "preset:aquatic:march".',
    ),
    out_format: z.enum(['glb', 'fbx']).optional().describe('Default "glb".'),
    bake_animation: z.boolean().optional().describe('Bake animation into the model (glb only). Default true.'),
    export_with_geometry: z.boolean().optional().describe('Default true.'),
    animate_in_place: z.boolean().optional().describe('No root displacement. Default false.'),
    dry_run: dryRun,
  },
  async ({ dry_run, animations, ...rest }) =>
    submit('/animations/retarget', {
      ...rest,
      ...(animations.length === 1 ? { animation: animations[0] } : { animations }),
    }, dry_run),
);

// ---------------------------------------------------------------------------
// Tasks, files and account (all free)
// ---------------------------------------------------------------------------

tool(
  'get_task_status',
  'Get the status, progress and output URLs of a task. Free.',
  { task_id: z.string().describe('Task ID returned when the task was created.') },
  async ({ task_id }) => ok(await api.getTask(task_id)),
  { readOnlyHint: true },
);

tool(
  'get_tasks',
  'Get the status of up to 100 tasks at once. Free.',
  { task_ids: z.array(z.string()).min(1).max(100) },
  async ({ task_ids }) => ok(await api.getTasks(task_ids)),
  { readOnlyHint: true },
);

tool(
  'wait_for_task',
  'Poll a task until it finishes or the timeout passes, then return it. If it is still running, call again; the task keeps running on Tripo either way. 3D generation typically takes 2–5 minutes. Free.',
  {
    task_id: z.string(),
    timeout_seconds: z.number().int().min(1).max(600).optional().describe('How long to wait. Default 50, which stays under the 60-second request timeout many MCP clients use; raise it only if your client allows longer calls.'),
    poll_interval_seconds: z.number().int().min(1).max(30).optional().describe('Default 3.'),
  },
  async ({ task_id, timeout_seconds = 50, poll_interval_seconds = 3 }, extra) => {
    const deadline = Date.now() + timeout_seconds * 1000;
    const progressToken = extra?._meta?.progressToken;
    let task: TripoTask;
    for (;;) {
      task = await api.getTask(task_id);
      if (progressToken !== undefined) {
        await extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: task.progress ?? 0, total: 100, message: task.status },
        }).catch(() => undefined);
      }
      if (TERMINAL_STATUSES.has(task.status) || Date.now() + poll_interval_seconds * 1000 > deadline) break;
      await new Promise((resolve) => setTimeout(resolve, poll_interval_seconds * 1000));
    }
    if (!TERMINAL_STATUSES.has(task.status)) {
      return ok({ ...task, note: `Still ${task.status} after ${timeout_seconds}s. Call wait_for_task again to keep waiting.` });
    }
    return ok(task);
  },
  { readOnlyHint: true },
);

tool(
  'download_task_output',
  'Download every file URL in a successful task\'s output (model, preview render, images, …) to a local folder. Output URLs expire, so download soon after completion. Free.',
  {
    task_id: z.string(),
    output_dir: z.string().describe('Folder to save into (created if missing).'),
    file_prefix: z.string().optional().describe('Base filename. "chair" saves the model as chair.glb, the preview render as chair-preview.png, and any other outputs as chair-<output-name>. Default is the task ID.'),
    overwrite: z.boolean().optional().describe('Overwrite existing files. Default false.'),
  },
  async ({ task_id, output_dir, file_prefix, overwrite = false }) => {
    const task = await api.getTask(task_id);
    if (task.status !== 'success') {
      throw new Error(`Task ${task_id} is ${task.status}, not success; nothing to download.`);
    }
    const urls: [string, string][] = [];
    for (const [key, value] of Object.entries(task.output ?? {})) {
      const name = key.replace(/_url$/, '');
      if (typeof value === 'string' && /^https?:\/\//.test(value)) {
        urls.push([name, value]);
      } else if (Array.isArray(value)) {
        value.forEach((item, i) => {
          if (typeof item === 'string' && /^https?:\/\//.test(item)) urls.push([`${name}-${i + 1}`, item]);
        });
      }
    }
    if (urls.length === 0) {
      return ok({ task_id, saved: [], note: 'The task output contains no file URLs.', output: task.output });
    }

    const dir = expandPath(output_dir);
    const prefix = file_prefix ?? task_id;
    const targets = urls.map(([name, url]) => {
      const ext = path.extname(new URL(url).pathname) || '.bin';
      const suffix = name === 'model' ? '' : `-${name === 'rendered_image' ? 'preview' : name.replace(/_/g, '-')}`;
      return { name, url, file: path.join(dir, `${prefix}${suffix}${ext}`) };
    });
    if (!overwrite) {
      const existing = targets.filter((t) => fs.existsSync(t.file)).map((t) => t.file);
      if (existing.length) throw new Error(`Refusing to overwrite: ${existing.join(', ')}. Pass overwrite: true or another file_prefix.`);
    }

    const saved = [];
    await fs.promises.mkdir(dir, { recursive: true });
    for (const target of targets) {
      const bytes = await api.download(target.url);
      const actualExt = sniffExtension(bytes);
      let file = target.file;
      if (actualExt && path.extname(file) !== actualExt) {
        file = file.slice(0, -path.extname(file).length) + actualExt;
        if (!overwrite && fs.existsSync(file)) throw new Error(`Refusing to overwrite: ${file}.`);
      }
      await fs.promises.writeFile(file, bytes);
      saved.push({ output: target.name, path: file, bytes: bytes.length });
    }
    return ok({ task_id, type: task.type, credits_consumed: task.credits_consumed, saved });
  },
);

tool(
  'upload_file',
  'Upload a local image (JPEG, PNG, WebP; max 20 MB) or model (GLB, GLTF, FBX, OBJ, STL; max 150 MB) and get a reusable file token. Large files go through a presigned upload automatically. Other tools also accept local paths directly. Free.',
  { file_path: z.string().describe('Path to the file.') },
  async ({ file_path }) => ok({ file_token: await api.uploadFile(expandPath(file_path)) }),
);

tool(
  'get_balance',
  'Get the API account\'s available and frozen (reserved for running tasks) credits. Free.',
  {},
  async () => ok(await api.getBalance()),
  { readOnlyHint: true },
);

tool(
  'get_usage',
  'List recent tasks with the credits each consumed. Free.',
  {},
  async () => ok(await api.getUsage()),
  { readOnlyHint: true },
);

const transport = new StdioServerTransport();
await server.connect(transport);
