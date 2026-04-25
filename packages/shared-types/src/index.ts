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

/**
 * Optional scope binding sent with a chat request.
 *
 * `legacy_session_id` is the integer id from the legacy CL2 plenarias API
 * (api.agentescl2.com/api/users/transcripciones). When present, the BFF
 * fetches that session's metadata and injects it into the LLM as a system
 * message — the user's content stays clean and the conversation is tagged
 * in the database as belonging to that plenaria.
 *
 * See docs/issues/001-session-scoped-chat-production.md.
 */
export interface ChatScope {
  legacy_session_id?: number;
}

export interface CerebroRequest {
  tenant: 'cl2';
  agent_id: AgentId;
  query: string;
  conversation_id?: string;
  deep_insight: boolean;
  model_override?: string;
  context?: Record<string, unknown>;
  scope?: ChatScope;
}

export interface CerebroStreamChunk {
  type:
    | 'token'
    | 'tool_call'
    | 'tool_result'
    | 'citation'
    | 'conversation'
    | 'confidence'
    | 'done'
    | 'error';
  payload?: unknown;
}

export interface ConfidencePayload {
  score: number;
  level: 'high' | 'medium' | 'low';
  rationale: string;
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
