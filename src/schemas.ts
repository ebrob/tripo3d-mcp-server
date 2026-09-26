import { z } from 'zod';

// Accepted by the live API as of 2026-09 (the docs' "tripo-v3.1"-style aliases are rejected).
export const MODEL_3D_VERSIONS = ['v3.1-20260211', 'v3.0-20250812', 'v2.5-20250123', 'P1-20260311', 'P2-20260801'] as const;
export const DEFAULT_3D_MODEL = 'v3.1-20260211';
export const TEXTURE_VERSIONS = ['v3.5-20260815', 'v3.0-20250812', 'v2.5-20250123'] as const;
export const IMAGE_MODELS = [
  'seedream_v4', 'seedream_v5', 'banana', 'banana_pro', 'banana2',
  'chat_image_1', 'chat_image_1.5', 'chat_image_2', 'chat_image_2.5_flare', 'chat_image_2.5_sunburst',
] as const;
export const RIG_TYPES = ['biped', 'quadruped', 'hexapod', 'octopod', 'avian', 'serpentine', 'aquatic'] as const;

export const sourceDescription =
  'A local file path (uploaded automatically), a public http(s) URL, a file token ("file_…") from upload_file, or a task ID from an earlier task.';

export const dryRun = z.boolean().optional().describe(
  'If true, return the request that would be sent without uploading files or creating a task. Nothing is charged.',
);

const textureQuality = z.enum(['fast', 'standard', 'detailed', 'extreme']).optional().describe(
  'Texture quality. "fast" requires texture_version "v3.5-20260815". "detailed" and "extreme" (8K) cost extra credits. Default "standard".',
);

// Options shared by text-, image- and multiview-to-model.
export const generationOptions = {
  model: z.enum(MODEL_3D_VERSIONS).optional().describe(
    `Geometry model. H series: "v3.1-20260211" (default, highest fidelity), "v3.0-20250812", "v2.5-20250123". ` +
      'P series (clean low-poly topology): "P1-20260311", "P2-20260801" (adds quad support). ' +
      'P series does not support geometry_quality, smart_low_poly, generate_parts or compress.',
  ),
  face_limit: z.number().int().positive().optional().describe(
    'Maximum faces. Omit for adaptive topology. v3.1 up to 1,500,000 triangles; P1 50–20,000; P2 48–50,000 (48–25,000 with quad).',
  ),
  texture: z.boolean().optional().describe('Generate textures. Default true. Set false (with pbr false) for bare geometry, which costs less.'),
  pbr: z.boolean().optional().describe('Generate PBR maps (forces texture on). Default true.'),
  texture_quality: textureQuality,
  texture_version: z.enum(TEXTURE_VERSIONS).optional().describe(
    'Pin the texture model independently of geometry. Default is derived from model (v2.5 → v2.5-20250123, otherwise v3.0-20250812).',
  ),
  delight: z.boolean().optional().describe('Remove baked-in lighting from the reference before texturing. Default true. Only read by texture_version v3.5-20260815.'),
  geometry_quality: z.enum(['standard', 'detailed']).optional().describe('"detailed" is Ultra mode (extra credits). H series v3.0+ only. Default "standard".'),
  auto_size: z.boolean().optional().describe('Scale the model to real-world size in meters. Default false.'),
  quad: z.boolean().optional().describe('Output a quad mesh (forces FBX output; extra credits). H series v3.0+ or P2. Default false.'),
  smart_low_poly: z.boolean().optional().describe('Hand-crafted-style low-poly topology (extra credits). H series v3.0+ only. Default false.'),
  generate_parts: z.boolean().optional().describe('Generate editable segmented parts (extra credits). Requires texture=false and pbr=false. Default false.'),
  compress: z.enum(['geometry']).optional().describe('"geometry" applies meshopt compression.'),
  model_seed: z.number().int().optional().describe('Seed for geometry generation (same seed + input = same mesh).'),
  texture_seed: z.number().int().optional().describe('Seed for texture generation.'),
  export_uv: z.boolean().optional().describe('UV-unwrap during generation. Default true; false is faster.'),
  export_orientation: z.enum(['+x', '-x', '+y', '-y']).optional().describe(
    'Forward axis for this export. Leave unset if the model will be post-processed (texture/rig/convert); use convert_model to reorient at the end instead.',
  ),
};

export const imageGenerationOptions = {
  size: z.string().optional().describe('Output size: a keyword such as "2K"/"4K" or explicit "WIDTHxHEIGHT". Default "2048x2048". Used by seedream and chat_image models.'),
  aspect_ratio: z.string().optional().describe('Aspect ratio such as "1:1", "16:9", "3:4". banana models only (banana2 also allows 1:8, 1:4, 4:1, 8:1).'),
  quality: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().describe(
    'chat_image_2 (low/medium/high) and chat_image_2.5_* (all tiers) only. Default "low". high/xhigh/max cost extra credits.',
  ),
  background: z.enum(['auto', 'opaque', 'transparent']).optional().describe('chat_image_2.5_* only. "transparent" requires output_format "png".'),
  output_format: z.enum(['png', 'jpeg']).optional().describe('Default "png".'),
};
