"use client";

import { useState, Fragment } from "react";
import docNamesData from "@/data/doc_names.json";

type DocMeta = { display_name: string; source_url: string };
const docList: DocMeta[] = Object.values(docNamesData as Record<string, DocMeta>);

type Source = {
  n: number;
  doc_name: string;
  source_url: string;
  page: number;
  content: string;
  similarity: number;
};

const EXAMPLE_QUESTIONS = [
  "喀痰吸引とはどのような行為ですか？",
  "経管栄養が必要になるのはどのような場合ですか？",
  "登録喀痰吸引等事業者の登録申請は事業所ごとに行う必要がありますか？",
];

function renderAnswer(answer: string, sources: Source[]) {
  const parts = answer.split(/(\[\d+\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d+)\]$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const exists = sources.some((s) => s.n === n);
      if (exists) {
        return (
          <a
            key={i}
            href={`#source-${n}`}
            className="inline-block font-medium text-teal-700 hover:text-teal-900 hover:underline"
          >
            {part}
          </a>
        );
      }
    }
    return <Fragment key={i}>{part}</Fragment>;
  });
}

export default function Home() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [answer, setAnswer] = useState<string | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function ask(q: string) {
    const trimmed = q.trim();
    if (!trimmed || loading) return;

    setLoading(true);
    setError(null);
    setAnswer(null);
    setSources([]);

    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        setError(data?.error || "エラーが発生しました。しばらくしてから再度お試しください。");
        return;
      }

      setAnswer(data.answer);
      setSources(data.sources || []);
    } catch {
      setError("通信エラーが発生しました。ネットワーク状態を確認してください。");
    } finally {
      setLoading(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    ask(question);
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <main className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-10 sm:px-6">
        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
            介護資料 根拠付きQ&A（試作）
          </h1>
          <p className="text-sm text-slate-600 sm:text-base">
            公開資料をもとに、出典付きで回答する試作デモです。
          </p>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              読み込み済みの資料
            </p>
            <ul className="flex flex-col gap-1 text-sm text-slate-700">
              {docList.map((doc) => (
                <li key={doc.display_name} className="flex items-start gap-2">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-teal-600" />
                  <span>{doc.display_name}</span>
                </li>
              ))}
            </ul>
          </div>
        </header>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label htmlFor="question" className="text-sm font-medium text-slate-700">
            質問を入力してください
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="question"
              type="text"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="例：喀痰吸引とはどのような行為ですか？"
              className="flex-1 rounded-lg border border-slate-300 px-4 py-2.5 text-sm shadow-sm focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600"
            />
            <button
              type="submit"
              disabled={loading || !question.trim()}
              className="rounded-lg bg-teal-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {loading ? "回答生成中…" : "質問する"}
            </button>
          </div>

          <div className="flex flex-wrap gap-2 pt-1">
            {EXAMPLE_QUESTIONS.map((eq) => (
              <button
                key={eq}
                type="button"
                onClick={() => {
                  setQuestion(eq);
                  ask(eq);
                }}
                disabled={loading}
                className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-600 transition hover:border-teal-600 hover:text-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {eq}
              </button>
            ))}
          </div>
        </form>

        {loading && (
          <div className="flex items-center gap-2 text-sm text-slate-500">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-teal-700" />
            回答を生成しています…
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}

        {answer && !loading && (
          <section className="flex flex-col gap-6">
            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                回答
              </p>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-800 sm:text-base">
                {renderAnswer(answer, sources)}
              </p>
            </div>

            {sources.length > 0 && (
              <div className="flex flex-col gap-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  出典
                </p>
                {sources.map((s) => (
                  <details
                    key={s.n}
                    id={`source-${s.n}`}
                    className="scroll-mt-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <summary className="cursor-pointer list-none text-sm font-medium text-slate-800">
                      <span className="mr-2 inline-block rounded bg-teal-100 px-1.5 py-0.5 text-xs font-semibold text-teal-800">
                        [{s.n}]
                      </span>
                      {s.doc_name}（p.{s.page}）
                    </summary>
                    <div className="mt-3 flex flex-col gap-3">
                      <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-xs leading-relaxed text-slate-600 sm:text-sm">
                        {s.content}
                      </p>
                      {s.source_url && (
                        <a
                          href={`${s.source_url}#page=${s.page}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex w-fit items-center gap-1 text-xs font-medium text-teal-700 hover:text-teal-900 hover:underline sm:text-sm"
                        >
                          原文PDFを開く ↗
                        </a>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        )}

        <footer className="mt-8 border-t border-slate-200 pt-6 text-xs text-slate-500">
          本デモは公開資料に基づく試作であり、専門的な判断の代わりにはなりません。
        </footer>
      </main>
    </div>
  );
}
