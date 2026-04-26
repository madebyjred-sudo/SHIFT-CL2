/**
 * Podcast audio storage — GCS bucket `shift-cl2-podcasts` (configurable
 * via PODCAST_GCS_BUCKET).
 *
 * Mirrors the pattern in routes/expedientes.ts: write the mp3 with
 * service-account creds, read via signed URL with TTL. The route layer
 * gates listing + read access via Supabase JWT; GCS itself trusts the
 * signature on the URL.
 */
import { Storage, type Bucket } from '@google-cloud/storage';
import { withTimeout } from './resilience.js';

const SIGNED_URL_TTL_MS = 30 * 60 * 1000; // 30 min — long enough to play + redownload
const UPLOAD_TIMEOUT_MS = 60_000;
const SIGN_TIMEOUT_MS = 15_000;

let _storage: Storage | null = null;
function bucket(): Bucket {
  if (!_storage) _storage = new Storage();
  const name = process.env.PODCAST_GCS_BUCKET ?? 'shift-cl2-podcasts';
  return _storage.bucket(name);
}

/**
 * Upload an mp3 to gs://{bucket}/{userId}/{podcastId}.mp3 and return
 * the canonical gs:// path. The path is what we persist in the DB; we
 * sign on read.
 */
export async function uploadPodcastAudio(
  userId: string,
  podcastId: string,
  mp3: Buffer,
): Promise<string> {
  const objectPath = `${userId}/${podcastId}.mp3`;
  const file = bucket().file(objectPath);
  await withTimeout(
    () =>  // GCS save() doesn't expose AbortSignal — timeout enforced by wrapper.
      file.save(mp3, {
        contentType: 'audio/mpeg',
        resumable: false,
        metadata: {
          cacheControl: 'private, max-age=86400',
        },
      }),
    { ms: UPLOAD_TIMEOUT_MS, label: 'gcs:upload_podcast' },
  );
  return `gs://${bucket().name}/${objectPath}`;
}

/**
 * Sign a short-lived read URL for an audio_path. Same pattern as the
 * expediente PDF view URLs — caller already authenticated via JWT.
 */
export async function signPodcastAudio(audioPath: string): Promise<string> {
  const m = audioPath.match(/^gs:\/\/([^/]+)\/(.+)$/);
  if (!m) throw new Error(`bad gcs path: ${audioPath}`);
  const [, bucketName, objectPath] = m;
  const file = new Storage().bucket(bucketName).file(objectPath);
  const [url] = await withTimeout(
    () =>  // getSignedUrl() doesn't expose AbortSignal.
      file.getSignedUrl({
        version: 'v4',
        action: 'read',
        expires: Date.now() + SIGNED_URL_TTL_MS,
      }),
    { ms: SIGN_TIMEOUT_MS, label: 'gcs:sign_podcast' },
  );
  return url;
}
