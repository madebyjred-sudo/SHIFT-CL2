import { Router } from 'express';
import { Storage } from '@google-cloud/storage';
import { createClient } from '@supabase/supabase-js';

const storage = new Storage();
const _supa = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

export async function silDownloadHandler(req: any, res: any) {
  try {
    const { docId } = req.params;
    const { data: doc, error } = await _supa
      .from('sil_documentos')
      .select('gcs_path, tipo, expediente_id')
      .eq('id', docId)
      .single();

    if (error || !doc) {
      return res.status(404).send('Not found');
    }

    if (!doc.gcs_path) {
      return res.status(404).send('No storage path found');
    }

    // gcs_path is gs://bucket/path
    const matches = doc.gcs_path.match(/^gs:\/\/([^\/]+)\/(.+)$/);
    if (!matches) {
      return res.status(500).send('Invalid GCS path');
    }

    const bucketName = matches[1];
    const fileName = matches[2];

    const file = storage.bucket(bucketName).file(fileName);
    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'read',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
    });

    res.redirect(url);
  } catch (err) {
    req.log?.error('sil_download failed', { error: (err as Error).message });
    res.status(500).send('Download failed');
  }
}
