"""
介護資料 根拠付きQ&A - 取り込みスクリプト

data/ 配下の PDF を読み込み、ページ単位でテキストを抽出・分割し、
埋め込みベクトルを生成して Supabase の chunks テーブルに登録します。

再実行しても重複しないよう、挿入前に chunks テーブルを空にします。

使い方:
    python scripts/ingest.py

必要な環境変数 (.env またはシェル環境):
    SUPABASE_URL
    SUPABASE_SERVICE_ROLE_KEY
    OPENAI_API_KEY
"""

import glob
import io
import json
import os
import re
import sys

if sys.stdout.encoding is None or sys.stdout.encoding.lower() != "utf-8":
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8")

import fitz  # PyMuPDF
from dotenv import load_dotenv
from openai import OpenAI
from supabase import create_client

load_dotenv()

ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT_DIR, "data")
DOC_NAMES_PATH = os.path.join(DATA_DIR, "doc_names.json")

CHUNK_SIZE = 500
CHUNK_OVERLAP = 100
MIN_CHUNK_LEN = 50
NEAR_EMPTY_PAGE_LEN = 20  # ほぼ空白とみなす文字数の閾値
EMBEDDING_MODEL = "openai/text-embedding-3-small"  # OpenRouter 経由で呼び出す
OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
EMBEDDING_BATCH_SIZE = 100
INSERT_BATCH_SIZE = 200


def load_doc_names() -> dict:
    with open(DOC_NAMES_PATH, "r", encoding="utf-8") as f:
        return json.load(f)


def clean_text(text: str) -> str:
    """余分な空白・改行を取り除く。日本語は単語間にスペースを必要としない
    ため、改行は連結し、連続する半角スペース／タブは 1 個にまとめる。"""
    text = text.replace("\r", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" *\n *", "", text)
    text = re.sub(r" {2,}", " ", text)
    return text.strip()


def chunk_text(text: str, chunk_size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """およそ chunk_size 文字ごとに分割する。可能な場合は「。」の直後で
    区切り、overlap 文字分を次のチャンクと重複させる。"""
    chunks = []
    n = len(text)
    start = 0
    while start < n:
        end = min(start + chunk_size, n)
        if end < n:
            search_start = start + int(chunk_size * 0.5)
            idx = text.rfind("。", search_start, end)
            if idx != -1 and idx + 1 > start:
                end = idx + 1
        piece = text[start:end].strip()
        if piece:
            chunks.append(piece)
        if end >= n:
            break
        start = max(end - overlap, start + 1)
    return chunks


def extract_pages(pdf_path: str) -> list[str]:
    """PDF を開き、ページごとのテキストのリストを返す (index 0 = 1 ページ目)。"""
    doc = fitz.open(pdf_path)
    pages = [doc[i].get_text() for i in range(doc.page_count)]
    doc.close()
    return pages


def get_embeddings(client: OpenAI, texts: list[str]) -> list[list[float]]:
    embeddings: list[list[float]] = []
    for i in range(0, len(texts), EMBEDDING_BATCH_SIZE):
        batch = texts[i : i + EMBEDDING_BATCH_SIZE]
        resp = client.embeddings.create(model=EMBEDDING_MODEL, input=batch)
        embeddings.extend([item.embedding for item in resp.data])
    return embeddings


def main() -> None:
    supabase_url = os.environ.get("SUPABASE_URL")
    supabase_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    openai_key = os.environ.get("OPENAI_API_KEY")

    missing = [
        name
        for name, val in [
            ("SUPABASE_URL", supabase_url),
            ("SUPABASE_SERVICE_ROLE_KEY", supabase_key),
            ("OPENAI_API_KEY", openai_key),
        ]
        if not val
    ]
    if missing:
        print(f"エラー: 環境変数が設定されていません: {', '.join(missing)}")
        sys.exit(1)

    supabase = create_client(supabase_url, supabase_key)
    openai_client = OpenAI(api_key=openai_key, base_url=OPENROUTER_BASE_URL)

    doc_names = load_doc_names()

    pdf_paths = sorted(glob.glob(os.path.join(DATA_DIR, "*.pdf")))
    if not pdf_paths:
        print(f"エラー: {DATA_DIR} に PDF が見つかりません。")
        sys.exit(1)

    print(f"{len(pdf_paths)} 件の PDF を処理します。\n")

    all_rows: list[dict] = []
    summary: list[dict] = []

    for pdf_path in pdf_paths:
        fname = os.path.basename(pdf_path)
        meta = doc_names.get(fname)
        if meta:
            doc_name = meta["display_name"]
            source_url = meta["source_url"]
        else:
            doc_name = os.path.splitext(fname)[0]
            source_url = ""
            print(f"警告: {fname} が doc_names.json にありません。ファイル名を使用します。")

        pages = extract_pages(pdf_path)
        n_pages = len(pages)
        n_near_empty = 0
        n_chunks_doc = 0

        for page_idx, raw_text in enumerate(pages):
            page_num = page_idx + 1
            stripped_len = len(raw_text.strip())
            if stripped_len < NEAR_EMPTY_PAGE_LEN:
                n_near_empty += 1

            cleaned = clean_text(raw_text)
            if not cleaned:
                continue

            for piece in chunk_text(cleaned):
                if len(piece) < MIN_CHUNK_LEN:
                    continue
                all_rows.append(
                    {
                        "doc_name": doc_name,
                        "source_url": source_url,
                        "page": page_num,
                        "content": piece,
                    }
                )
                n_chunks_doc += 1

        summary.append(
            {
                "file": fname,
                "doc_name": doc_name,
                "pages": n_pages,
                "chunks": n_chunks_doc,
                "near_empty_pages": n_near_empty,
            }
        )
        print(f"[抽出完了] {fname} -> {doc_name}: {n_pages} ページ, {n_chunks_doc} チャンク, ほぼ空白 {n_near_empty} ページ")

    print(f"\n合計チャンク数: {len(all_rows)}")
    print("埋め込みベクトルを生成中...")
    embeddings = get_embeddings(openai_client, [row["content"] for row in all_rows])
    for row, emb in zip(all_rows, embeddings):
        row["embedding"] = emb

    print("既存データを削除中...")
    supabase.table("chunks").delete().gte("id", 0).execute()

    print("Supabase に挿入中...")
    for i in range(0, len(all_rows), INSERT_BATCH_SIZE):
        batch = all_rows[i : i + INSERT_BATCH_SIZE]
        supabase.table("chunks").insert(batch).execute()
        print(f"  {min(i + INSERT_BATCH_SIZE, len(all_rows))}/{len(all_rows)} 件挿入済み")

    print("\n===== 取り込みサマリー =====")
    for s in summary:
        flag = "  ← 要確認 (ほぼ空白ページあり)" if s["near_empty_pages"] > 0 else ""
        print(f"{s['doc_name']} ({s['file']}): {s['pages']} ページ, {s['chunks']} チャンク, ほぼ空白 {s['near_empty_pages']} ページ{flag}")
    print(f"\n総チャンク数: {len(all_rows)}")
    print("完了しました。")


if __name__ == "__main__":
    main()
