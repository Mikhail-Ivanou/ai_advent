// Day 24: how a RAG answer was checked — its sources (real chunks), quotes
// looked up in those chunks, or why the assistant said "не знаю".

export type Grounding = {
  status: 'answered' | 'unknown';
  reason?: 'low-relevance' | 'model' | 'unverified';
  answer: string;
  sources: { n: number; chunk_id: string; source: string; title: string; section: string; file: string }[];
  quotes: { n: number; text: string; match: 'exact' | 'approximate' | 'not-found'; chunk_id?: string }[];
  invalidRefs: number[];
  rejectedAnswer?: string;
  topScore?: number;
  threshold?: number;
};

const MATCH_LABELS: Record<Grounding['quotes'][number]['match'], { mark: string; title: string; className: string }> = {
  exact: { mark: '✓', title: 'дословно есть в чанке', className: 'text-pine' },
  approximate: { mark: '≈', title: 'почти дословно (≥ 85% слов по порядку)', className: 'text-amber-600' },
  'not-found': { mark: '✗', title: 'в чанке не найдена', className: 'text-red-600' },
};

const UNKNOWN_REASONS: Record<NonNullable<Grounding['reason']>, string> = {
  'low-relevance': 'слабый контекст: ни один фрагмент не прошёл порог релевантности, LLM не вызывалась',
  model: 'модель не нашла ответа в переданных фрагментах',
  unverified: 'ответ модели не подтвердился цитатами — не выдаётся как ответ',
};

export function GroundingView({ grounding }: { grounding: Grounding }) {
  const confirmed = grounding.quotes.filter((q) => q.match !== 'not-found').length;
  return (
    <div className="mt-1 rounded-md border border-black/10 bg-white px-2 py-1 text-[11px]">
      {grounding.status === 'answered' ? (
        <p className="text-pine">
          ✓ Подтверждено: источников {grounding.sources.length}, цитат {confirmed} из {grounding.quotes.length}
        </p>
      ) : (
        <p className="text-amber-700">
          «Не знаю» — {grounding.reason ? UNKNOWN_REASONS[grounding.reason] : 'нет ответа'}
          {grounding.topScore !== undefined && grounding.threshold !== undefined && (
            <>
              {' '}
              (лучшая релевантность {grounding.topScore.toFixed(3)} &lt; порог {grounding.threshold})
            </>
          )}
        </p>
      )}
      {grounding.sources.length > 0 && (
        <div className="mt-1">
          <span className="text-[#5c5c5c]">Источники:</span>
          <ul className="pl-2">
            {grounding.sources.map((s) => (
              <li key={s.chunk_id}>
                [{s.n}] {s.file} › {s.section.split(' › ').slice(-2).join(' › ') || '—'}{' '}
                <span className="font-mono text-[#5c5c5c]">{s.chunk_id}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {grounding.quotes.length > 0 && (
        <div className="mt-1">
          <span className="text-[#5c5c5c]">Цитаты:</span>
          <ul className="pl-2">
            {grounding.quotes.map((q, i) => {
              const m = MATCH_LABELS[q.match];
              return (
                <li key={i}>
                  <span className={m.className} title={m.title}>
                    {m.mark}
                  </span>{' '}
                  [{q.n}] «{q.text}»
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {grounding.invalidRefs.length > 0 && (
        <p className="text-red-600">Ссылки на несуществующие фрагменты: {grounding.invalidRefs.map((n) => `[${n}]`).join(', ')}</p>
      )}
      {grounding.rejectedAnswer && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[#5c5c5c]">Отклонённый ответ модели</summary>
          <p className="whitespace-pre-wrap text-[#5c5c5c]">{grounding.rejectedAnswer}</p>
        </details>
      )}
    </div>
  );
}
