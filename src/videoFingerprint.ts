import { createHash } from 'crypto';
import { open, stat } from 'fs/promises';

const SAMPLE_SIZE = 1024 * 1024; // 1MB

// Fingerprints by size + first/last 1MB instead of hashing the whole file —
// full hashes of multi-GB video files on every scan is too costly, especially over network storage.
export async function computeVideoFingerprint(videoPath: string): Promise<string> {
  const { size } = await stat(videoPath);
  const hash = createHash('sha256');
  hash.update(String(size));

  const handle = await open(videoPath, 'r');
  try {
    const headSize = Math.min(SAMPLE_SIZE, size);
    if (headSize > 0) {
      const head = Buffer.alloc(headSize);
      await handle.read(head, 0, headSize, 0);
      hash.update(head);
    }

    if (size > SAMPLE_SIZE) {
      const tail = Buffer.alloc(SAMPLE_SIZE);
      await handle.read(tail, 0, SAMPLE_SIZE, size - SAMPLE_SIZE);
      hash.update(tail);
    }
  } finally {
    await handle.close();
  }

  return hash.digest('hex');
}
