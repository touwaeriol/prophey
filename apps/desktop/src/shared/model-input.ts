/**
 * Which modalities a model entry declares.
 *
 * pi's catalog treats a missing `input` as text-only (`provider-composer.ts`:
 * `input: definition.input ?? ["text"]`), and `transformMessages()` then replaces every image block
 * with `(image omitted: model does not support images)` before the request leaves the process. So a
 * custom model in `models.json` that never declares `input` swallows screenshots without any error
 * anywhere — the model is simply asked about a picture it cannot see.
 *
 * The switch lives next to `contextWindow` in 设置 → 服务商, because both are provider declarations
 * pi cannot infer for a hand-written model entry.
 */

export type ModelModality = "text" | "image";

/** Whether a `models.json` model entry says it accepts images. */
export function declaresImageInput(input: unknown): boolean {
  return Array.isArray(input) && input.includes("image");
}

/** The `input` array to write for the vision toggle. */
export function modelInputModalities(images: boolean): ModelModality[] {
  return images ? ["text", "image"] : ["text"];
}
