// Shift CL2 — shared types frontend ↔ backend ↔ worker

export type AgentId = 'lexa' | 'atlas' | 'centinela';

export interface Agent {
  id: AgentId;
  display_name: string;
  tagline: string;
  domain: 'legislativo' | 'documental' | 'monitor';
  default_model: string;
  deep_insight_model: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  agent_id?: AgentId;
  model?: string;
  deep_insight?: boolean;
  citations?: Citation[];
  confidence?: number;
  created_at: string;
}

export interface Citation {
  source_type: 'transcript' | 'pdf' | 'web' | 'metadata';
  ref: string;
  acta_num?: string;
  fecha?: string;
  timecode?: string;
  page?: number;
  url?: string;
  excerpt?: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  agent_id: AgentId;
  title: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
}

export interface Session {
  id: string;
  fecha: string;
  comision: string;
  tipo: 'plenario' | 'comision' | 'extraordinaria';
  video_url?: string;
  transcript_url?: string;
  status: 'pending' | 'processing' | 'indexed' | 'error';
}

export interface CerebroRequest {
  tenant: 'cl2';
  agent_id: AgentId;
  query: string;
  conversation_id?: string;
  deep_insight: boolean;
  model_override?: string;
  context?: Record<string, unknown>;
}

export interface CerebroStreamChunk {
  type: 'token' | 'tool_call' | 'tool_result' | 'citation' | 'done' | 'error';
  payload: unknown;
}

export interface IngestJob {
  id: string;
  type: 'pdf' | 'youtube' | 'manual_audio' | 'web_scrape';
  source_url?: string;
  status: 'queued' | 'running' | 'done' | 'error';
  result?: {
    chunks_indexed?: number;
    transcript_url?: string;
    error?: string;
  };
  created_at: string;
}
