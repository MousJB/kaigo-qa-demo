-- 介護資料 根拠付きQ&A - スキーマ定義
-- Supabase の SQL エディタでこのファイルの内容を実行してください。

create extension if not exists vector;

create table if not exists chunks (
  id bigserial primary key,
  doc_name text not null,
  source_url text not null,
  page int not null,
  content text not null,
  embedding vector(1536) not null
);

-- コサイン類似度検索用の HNSW インデックス
create index if not exists chunks_embedding_hnsw_idx
  on chunks
  using hnsw (embedding vector_cosine_ops);

-- 類似チャンク検索関数
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int default 5
)
returns table (
  id bigint,
  doc_name text,
  source_url text,
  page int,
  content text,
  similarity float
)
language sql stable
as $$
  select
    chunks.id,
    chunks.doc_name,
    chunks.source_url,
    chunks.page,
    chunks.content,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
