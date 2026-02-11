import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH, getR2BucketName } from '../config';

/**
 * Mount R2 bucket for persistent storage
 *
 * Strategy: call mountBucket directly.  If the bucket is already mounted
 * the SDK throws "already in use" which we treat as success.  This avoids
 * spawning a shell process (`mount | grep`) whose output is unreliably
 * captured by the sandbox startProcess API.
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns true if mounted successfully (or already mounted), false otherwise
 */
export async function mountR2Storage(sandbox: Sandbox, env: MoltbotEnv): Promise<boolean> {
  console.log('[R2] mountR2Storage called');

  // Skip if R2 credentials are not configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    console.log(
      '[R2] storage not configured (missing R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, or CF_ACCOUNT_ID)',
    );
    return false;
  }

  const bucketName = getR2BucketName(env);
  try {
    console.log('[R2] Mounting bucket', bucketName, 'at', R2_MOUNT_PATH);
    await sandbox.mountBucket(bucketName, R2_MOUNT_PATH, {
      endpoint: `https://${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
    console.log('[R2] bucket mounted successfully');
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    // "already in use" means the bucket is already mounted — this is success
    if (msg.includes('already in use')) {
      console.log('[R2] bucket already mounted at', R2_MOUNT_PATH);
      return true;
    }

    // Any other error is a genuine failure — but don't block gateway startup
    console.error('[R2] Failed to mount bucket:', msg);
    return false;
  }
}
