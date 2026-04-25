import { supabase } from '@/lib/supabase';

export interface UploadedDoc {
  doc_id: string;
  filename: string;
  pages: number;
  chars: number;
  truncated: boolean;
  text: string;
}

export async function uploadPdf(file: File): Promise<UploadedDoc> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;

  const form = new FormData();
  form.append('file', file);

  const res = await fetch('/api/ingest/pdf', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });

  const json = await res.json();
  if (!res.ok || !json.ok) {
    throw new Error(json.error ?? `upload failed: ${res.status}`);
  }
  return json as UploadedDoc;
}
