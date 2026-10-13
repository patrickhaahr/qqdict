import { constants } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

/** Import only the previous app's transcript/settings cache, leaving its original intact. */
export async function migrateLegacyHistory(dataDirectory: string, legacyDirectory: string): Promise<boolean> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const target = path.join(dataDirectory, 'history.json');
  try {
    await copyFile(path.join(legacyDirectory, 'history.json'), target, constants.COPYFILE_EXCL);
    await chmod(target, 0o600);
    return true;
  } catch (error) {
    if (['ENOENT', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw new Error('Could not import your previous dictation history. Your original history is unchanged.');
  }
}
