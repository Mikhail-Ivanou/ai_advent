// Lexical side of hybrid search (Day 22): BM25 over chunk texts. Embeddings
// of a small model blur rare names and terms ("Кирвисниеми", "Малакаль"),
// which is exactly what questions about a book are full of; BM25 catches
// them literally. Russian is handled with a crude stemmer — the word cut to
// its first letters — which is enough to match "Белову" with "Белов".

const STOP_WORDS = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня ' +
    'еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там ' +
    'потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе ' +
    'под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были ' +
    'куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая ' +
    'много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно ' +
    'всю между это кого кем каким какое какую каких откуда сколько почему зачем ' +
    'the a an of to in on and or is are was were be for with as by at from that this it what who how which'
  ).split(' '),
);

const stem = (word: string) => (word.length > 5 ? word.slice(0, Math.max(5, word.length - 3)) : word);

export function lexicalTokens(text: string): string[] {
  const words = text.toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\d]+/gu) ?? [];
  return words.filter((w) => w.length > 1 && !STOP_WORDS.has(w)).map(stem);
}

export class Bm25Index {
  private readonly termFreqs: Map<string, number>[];
  private readonly lengths: number[];
  private readonly docFreq = new Map<string, number>();
  private readonly avgLength: number;

  constructor(texts: string[], private readonly k1 = 1.2, private readonly b = 0.75) {
    this.termFreqs = texts.map((text) => {
      const tf = new Map<string, number>();
      for (const t of lexicalTokens(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
      return tf;
    });
    this.lengths = this.termFreqs.map((tf) => [...tf.values()].reduce((a, n) => a + n, 0));
    this.termFreqs.forEach((tf) => tf.forEach((_, t) => this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1)));
    this.avgLength = this.lengths.reduce((a, n) => a + n, 0) / Math.max(1, this.lengths.length);
  }

  /** BM25 score of every document for the query, in document order. */
  scores(query: string): number[] {
    const terms = [...new Set(lexicalTokens(query))];
    const n = this.termFreqs.length;
    const idf = terms.map((t) => {
      const df = this.docFreq.get(t) ?? 0;
      return Math.log(1 + (n - df + 0.5) / (df + 0.5));
    });
    return this.termFreqs.map((tf, i) => {
      let score = 0;
      terms.forEach((t, j) => {
        const f = tf.get(t);
        if (f) score += (idf[j] * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.lengths[i]) / this.avgLength));
      });
      return score;
    });
  }
}
