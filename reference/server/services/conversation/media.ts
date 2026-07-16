import { promises as fs } from 'fs';
import path from 'path';
import type { ConversationImage } from './types.js';

export interface HandleImagesResult {
  modifiedCommand: string | null;
  tempImagePaths: string[];
  tempDir: string | null;
}

/**
 * Handles image processing for SDK queries.
 * Extracts base64 data-URI images to temp files and appends a path list to the message.
 */
export async function handleImages(
  command: string | null,
  images: ConversationImage[] | null | undefined,
  cwd: string | null | undefined,
): Promise<HandleImagesResult> {
  const tempImagePaths: string[] = [];
  let tempDir: string | null = null;

  if (!images || images.length === 0) {
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }

  try {
    const workingDir = cwd || process.cwd();
    tempDir = path.join(workingDir, '.tmp', 'images', Date.now().toString());
    await fs.mkdir(tempDir, { recursive: true });

    for (const [index, image] of images.entries()) {
      const matches = image.data.match(/^data:([^;]+);base64,(.+)$/);
      if (!matches) continue;

      const [, mimeType, base64Data] = matches;
      if (!mimeType || !base64Data) continue;
      const extension = mimeType.split('/')[1] ?? 'png';
      const filename = `image_${index}.${extension}`;
      const filepath = path.join(tempDir, filename);

      await fs.writeFile(filepath, Buffer.from(base64Data, 'base64'));
      tempImagePaths.push(filepath);
    }

    let modifiedCommand: string | null = command;
    if (tempImagePaths.length > 0 && command?.trim()) {
      const imageNote = `\n\n[Images provided at the following paths:]\n${tempImagePaths.map((p, i) => `${i + 1}. ${p}`).join('\n')}`;
      modifiedCommand = command + imageNote;
    }

    return { modifiedCommand, tempImagePaths, tempDir };
  } catch (error) {
    console.error('[ConversationAdapter] Error processing images:', error);
    return { modifiedCommand: command, tempImagePaths, tempDir };
  }
}

/**
 * Cleans up temporary image files
 */
export async function cleanupTempFiles(
  tempImagePaths: string[] | null | undefined,
  tempDir: string | null | undefined,
): Promise<void> {
  if (!tempImagePaths || tempImagePaths.length === 0) return;

  try {
    for (const imagePath of tempImagePaths) {
      await fs.unlink(imagePath).catch(() => {});
    }
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    console.error('[ConversationAdapter] Error during cleanup:', error);
  }
}
