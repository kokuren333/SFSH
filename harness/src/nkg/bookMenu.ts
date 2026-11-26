/** A17: extensible menu, never a mandatory checklist. New pages can reuse BookTopic/BookLink. */
export const BOOK_MENU = [
  { module: 'B01', type: 'Thesis', label: '中心命題', slug: 'thesis', guide: '本の中心命題。著者の主張として帰属を明示する' },
  { module: 'B02', type: 'Argument', label: '論証構造図', slug: 'arguments', guide: '主張→根拠→事例→反例の論証。根拠から結論への飛躍も示す' },
  { module: 'B03', type: 'Concept', label: '概念マップ', slug: 'concepts', guide: '主要概念の定義と相互関係。用語集の羅列にせず関係を作る' },
  { module: 'B04', type: 'Evidence', label: '事例・証拠マップ', slug: 'evidence', guide: '歴史的エピソードやデータを論拠として扱う。主張の存在と事実の実証を混同しない' },
  { module: 'B05', type: 'Outline', label: '章ごとの論理要約', slug: 'outline', guide: '章・部の論理の流れ、結論から前提へのリバースアウトライン。章番号不明は捏造せず論点単位と明記' },
  { module: 'B06', type: 'AuthorContext', label: '著者と文脈', slug: 'author-context', guide: '著者の立場・知的文脈・成立事情。登場人物の動機に置き換えない' },
  { module: 'B07', type: 'Criticism', label: '批判と反論', slug: 'criticism', guide: '反論・批判・受容。批評家の実在する見解とハーネスの検討を区別' },
  { module: 'B08', type: 'Assumption', label: '前提・世界観', slug: 'assumptions', guide: '議論の前提・価値観・暗黙の仮定' },
  { module: 'B09', type: 'Chronology', label: '時系列', slug: 'chronology', guide: '歴史的な時間軸。物語の開示順ではない。対象に必要な場合だけ選択' },
  { module: 'B10', type: 'OpenQuestion', label: '未解決・留保', slug: 'open-questions', guide: '未解決点・留保・資料限界・予測の条件' },
] as const;
export const BOOK_TYPES = BOOK_MENU.map(m => m.type);
export type WorkKind = 'fiction' | 'nonfiction' | 'mixed';
/** Legacy display compatibility only. Identification must supply evidence for every new resolution. */
export function displayKind(w: { kind?: WorkKind | null }): WorkKind { return w.kind ?? 'fiction'; }
