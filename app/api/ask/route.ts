import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";

export const runtime = "nodejs";

// 類似度がこの値未満の場合は LLM を呼ばず「資料に記載がありません。」を返す
const SIMILARITY_THRESHOLD = 0.3;
const MATCH_COUNT = 5;
const NOT_FOUND_ANSWER = "資料に記載がありません。";

const SYSTEM_PROMPT = `あなたは介護資料に関する質問に答えるアシスタントです。以下の規則を厳守してください。
・提供された資料の抜粋のみを根拠に回答してください。
・各文の末尾に根拠となった抜粋の番号を [1] のように付けてください。
・抜粋の中に答えがない場合は「資料に記載がありません。」とだけ答えてください。
・推測や一般知識で補わないでください。
・簡潔で丁寧な日本語（です・ます調）で回答してください。`;

type MatchRow = {
  id: number;
  doc_name: string;
  source_url: string;
  page: number;
  content: string;
  similarity: number;
};

type Source = {
  n: number;
  doc_name: string;
  source_url: string;
  page: number;
  content: string;
  similarity: number;
};

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    const question = typeof body?.question === "string" ? body.question.trim() : "";

    if (!question) {
      return NextResponse.json({ error: "質問を入力してください。" }, { status: 400 });
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const llmModel = process.env.LLM_MODEL || "google/gemini-2.5-flash";

    if (!supabaseUrl || !supabaseKey || !openaiKey || !openrouterKey) {
      console.error("Missing required environment variables for /api/ask");
      return NextResponse.json(
        { error: "サーバー設定エラーが発生しました。しばらくしてから再度お試しください。" },
        { status: 500 }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    // 埋め込みは OpenRouter 経由で OpenAI のモデルを呼び出す
    const openai = new OpenAI({
      apiKey: openaiKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    // 1. 質問文を埋め込みベクトルに変換
    let queryEmbedding: number[];
    try {
      const embeddingResp = await openai.embeddings.create({
        model: "openai/text-embedding-3-small",
        input: question,
      });
      queryEmbedding = embeddingResp.data[0].embedding;
    } catch (err) {
      console.error("Embedding error:", err);
      return NextResponse.json(
        { error: "質問の処理中にエラーが発生しました。しばらくしてから再度お試しください。" },
        { status: 500 }
      );
    }

    // 2. 類似チャンクを検索
    const { data: matches, error: matchError } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbedding,
      match_count: MATCH_COUNT,
    });

    if (matchError) {
      console.error("Supabase match_chunks error:", matchError);
      return NextResponse.json(
        { error: "検索中にエラーが発生しました。しばらくしてから再度お試しください。" },
        { status: 500 }
      );
    }

    const results = (matches ?? []) as MatchRow[];

    // 3. 類似度が閾値未満なら LLM を呼ばずに即返答
    if (results.length === 0 || results[0].similarity < SIMILARITY_THRESHOLD) {
      return NextResponse.json({ answer: NOT_FOUND_ANSWER, sources: [] });
    }

    const sources: Source[] = results.map((r, i) => ({
      n: i + 1,
      doc_name: r.doc_name,
      source_url: r.source_url,
      page: r.page,
      content: r.content,
      similarity: r.similarity,
    }));

    const excerptsText = sources
      .map((s) => `[${s.n}] ${s.doc_name} (p.${s.page})\n${s.content}`)
      .join("\n\n");

    const userPrompt = `# 資料の抜粋\n${excerptsText}\n\n# 質問\n${question}`;

    // 4. LLM (OpenRouter) に回答を生成させる
    const openrouter = new OpenAI({
      apiKey: openrouterKey,
      baseURL: "https://openrouter.ai/api/v1",
    });

    let answer: string;
    try {
      const completion = await openrouter.chat.completions.create({
        model: llmModel,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      });
      answer = completion.choices[0]?.message?.content?.trim() || NOT_FOUND_ANSWER;
    } catch (err) {
      console.error("LLM error:", err);
      return NextResponse.json(
        { error: "回答生成中にエラーが発生しました。しばらくしてから再度お試しください。" },
        { status: 500 }
      );
    }

    return NextResponse.json({ answer, sources });
  } catch (err) {
    console.error("Unexpected error in /api/ask:", err);
    return NextResponse.json(
      { error: "エラーが発生しました。しばらくしてから再度お試しください。" },
      { status: 500 }
    );
  }
}
