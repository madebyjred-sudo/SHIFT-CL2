-- IVFFlat con lists=100 (más rápido que 1000) sobre legislative_chunks.embedding
SET statement_timeout = 0;
CREATE INDEX IF NOT EXISTS legislative_chunks_embedding_ivfflat_halfvec_idx
  ON legislative_chunks
  USING ivfflat ((embedding::halfvec(3072)) halfvec_cosine_ops)
  WITH (lists = 100);
