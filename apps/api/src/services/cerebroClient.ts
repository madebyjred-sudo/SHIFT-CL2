import type { CerebroStreamChunk, AgentId } from '@shift-cl2/shared-types';

interface StreamArgs {
  tenant: 'cl2';
  agent_id: AgentId;
  query: string;
  conversation_id?: string;
  deep_insight: boolean;
  model_override?: string;
  onChunk: (chunk: CerebroStreamChunk) => void;
}

const CEREBRO_BASE = process.env.CEREBRO_BASE_URL ?? 'http://localhost:8000';
const CEREBRO_KEY = process.env.CEREBRO_API_KEY ?? '';

export async function cerebroStream(args: StreamArgs): Promise<void> {
  const url = `${CEREBRO_BASE}/v1/chat/stream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${CEREBRO_KEY}`,
      'X-Tenant': args.tenant,
    },
    body: JSON.stringify({
      tenant: args.tenant,
      agent_id: args.agent_id,
      query: args.query,
      conversation_id: args.conversation_id,
      deep_insight: args.deep_insight,
      model_override: args.model_override,
    }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`cerebro upstream ${res.status}: ${await res.text()}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (!data || data === '[DONE]') continue;
      try {
        args.onChunk(JSON.parse(data) as CerebroStreamChunk);
      } catch {
        // skip malformed
      }
    }
  }
}
