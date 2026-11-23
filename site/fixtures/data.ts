import type { PublicWork } from '../src/public-types.ts';
import type { Work } from '../../harness/src/works/types.ts';
const date = '2026-01-02T00:00:00Z';
export const fixtures: PublicWork[] = [
  {
    schema: 'sfsh-public/1',
    work: { work_id: 'novel-akari-2020', title: '灯りの航路', title_original: 'Routes of Light', title_reading: 'あかりのこうろ', aliases_display: ['灯路'], medium: 'novel', creators: [{ name: '架空 葵', role: '著' }], genres: ['mystery'], tags: [], status: 'completed', first_release_year: 2020, publisher: '架空書房', coverage_label: '全体', spoiler_max: 'ending', has_matrix: true, first_published_at: date, updated_at: date },
    phases: [{ id: 'ph1', label: '出発', order: 1 }, { id: 'ph2', label: '到着', order: 2 }],
    viz: {
      relations: { characters: [{ id: 'ch1', label: '灯守', summary: '航路を考える人。', faction: 'f1', prominence: 1, epistemic: 'canon', grade: 'A', spoiler: 'none', source_refs: ['s1'] }, { id: 'ch2', label: '旅人', summary: null, faction: null, prominence: 2, epistemic: 'canon', grade: 'A', spoiler: 'none', source_refs: ['s1'] }], relations: [{ id: 'r1', from: 'ch1', to: 'ch2', kind: '協力', valence: 'positive', phase_from: 'ph1', phase_to: 'ph2', changed_by_label: null, epistemic: 'canon', grade: 'A', spoiler: 'mid', source_refs: ['s1'] }], factions: [{ id: 'f1', label: '灯台の家' }] },
      reverse_plot: { trees: [{ id: 'p1', kind: 'outcome', level: 'outcome', factor_kind: null, label: '新しい航路が選ばれる', summary: '合意が選択を支える。', analysis: '選択の背後には、知識を独占しないという約束が読み取れる。', epistemic: 'sfsh_analysis', grade: 'B', spoiler: 'ending', children: [{ id: 'p2', kind: 'why', level: 'direct', factor_kind: 'social', label: '二人が地図を共有する', summary: null, analysis: null, epistemic: 'canon', grade: 'A', spoiler: 'mid', children: [] }] }] },
      matrix: { secrets: [{ id: 'sct1', label: '灯台の目的', epistemic: 'canon', grade: 'A', spoiler: 'ending' }], holders: [{ id: 'ch1', label: '灯守', is_audience: false }, { id: 'audience', label: '読者', is_audience: true }], cells: [{ secret: 'sct1', holder: 'ch1', phase: 'ph1', state: 'knows' }, { secret: 'sct1', holder: 'audience', phase: 'ph2', state: 'knows' }] },
      timeline: { events: [{ id: 'e1', label: '出港', story_order: 1, disclosure_phase: 'ph1', spoiler: 'none' }] },
    },
    pages: {
      overview: [{ id: 'b1', heading: '協力と選択', paragraphs: ['異なる地図を持つ二人が、灯りの意味を比べる架空の物語です。', '<script>alert(1)</script> "onload= は安全性検査のための架空文字列です。'], spoiler: 'none', based_on: ['ch1'], epistemic: 'sfsh_analysis' }, { id: 'b2', heading: '航路の結末', paragraphs: ['最後の選択は、独占ではなく知識の共有として読むことができます。'], spoiler: 'ending', based_on: ['p1'], epistemic: 'sfsh_analysis' }],
      figure_notes: { relations: { id: 'note-a', heading: '関係図の読み方', paragraphs: ['協力関係をフェーズごとに比べます。'], spoiler: 'none', based_on: ['r1'], epistemic: 'sfsh_analysis' }, reverse_plot: null, matrix: null },
      themes: { intro: [], items: [{ id: 'th1', label: '知識の共有', question: '知識は誰のものか。', tension: '安全と自由の間の緊張。', values: ['協力', '自律'], summary: '航路を共有することの意味を考えます。', analysis: '共有は自由を減らすのではなく、責任を分け合う形として描かれる。', epistemic: 'sfsh_analysis', grade: 'B', spoiler: 'mid', source_refs: ['s1'] }] },
      context: { intro: [], items: [{ id: 'cx1', kind: 'reception', label: '架空の読書会', summary: '協働の物語として論じられたという設定です。', analysis: null, epistemic: 'consensus', grade: 'B', spoiler: 'none', source_refs: ['s1'] }], iconic: [{ id: 'ic1', label: '地図の交換', why_famous: '視点の違いを可視化する転機です。', analysis: '交換の後、二人の地図が一枚として扱われる点に転機の重みがある。', epistemic: 'sfsh_analysis', grade: 'B', spoiler: 'ending', source_refs: ['s1'] }] },
      interpretations: { intro: [], items: [{ id: 'in1', topic: '灯りの意味', positions: [{ claim: '制度の象徴として読めます。', epistemic: 'fan_theory', source_refs: ['s1'] }], spoiler: 'mid' }] },
      quiz: [{ id: 'q1', quiz_type: 'causal', question: '航路の選択を可能にしたのは何ですか。', answer: '地図の共有です。', explanation: '互いの不足を補うからです。', based_on: ['p1'], spoiler: 'ending' }],
    },
    elements: {
      events: [
        { id: 'e3', label: '新しい航路の決定', summary: '二人の合意で航路が選ばれる。', story_order: 3, phase_ref: 'ph2', epistemic: 'canon', grade: 'A', spoiler: 'ending', source_refs: ['s1'], caused_by: [{ event: 'e2', kind: 'enables' }, { event: 'e4', kind: 'prevents' }], leads_to: [] },
        { id: 'e1', label: '出港', summary: '灯守が旅人を船に迎える。', story_order: 1, phase_ref: 'ph1', epistemic: 'canon', grade: 'A', spoiler: 'none', source_refs: ['s1'], caused_by: [], leads_to: [{ event: 'e2', kind: 'causes' }] },
        { id: 'e2', label: '地図の交換', summary: null, story_order: 2, phase_ref: 'ph1', epistemic: 'canon', grade: 'B', spoiler: 'mid', source_refs: ['s1'], caused_by: [{ event: 'e1', kind: 'causes' }], leads_to: [{ event: 'e3', kind: 'enables' }] },
        { id: 'e4', label: '嵐の接近', summary: '外海の嵐が航路の選択肢を狭める。', story_order: null, phase_ref: null, epistemic: 'consensus', grade: 'C', spoiler: 'none', source_refs: ['s1'], caused_by: [], leads_to: [{ event: 'e3', kind: 'prevents' }] },
      ],
      motives: [
        { id: 'm1', owner: 'ch1', kind: 'goal', label: '航路を守りたい', summary: '灯りの知識を守ることが役目だと考えている。', analysis: '守ることが閉ざすことと紙一重である点が、変容の起点になる。', phase_from: 'ph1', phase_to: 'ph2', drives: ['e1', 'e3'], conflicts_with: ['m2'], epistemic: 'canon', grade: 'A', spoiler: 'none', source_refs: ['s1'] },
        { id: 'm2', owner: 'ch2', kind: 'fear', label: '道を失う恐れ', summary: '<img src=x onerror=alert(2)> & 安全性検査のための架空文字列です。 とても長い区切りのない文字列AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', analysis: null, phase_from: null, phase_to: 'ph1', drives: ['e2'], conflicts_with: ['m1'], epistemic: 'fan_theory', grade: 'C', spoiler: 'none', source_refs: ['s1'] },
      ],
      arcs: [{ id: 'a1', character: 'ch1', arc_type: '開放', label: '独占から共有へ', initial_state: '灯りの知識を一人で抱える', final_state: '知識を旅人と分け合う', summary: null, analysis: null, turns_at: ['e2'], epistemic: 'sfsh_analysis', grade: 'B', spoiler: 'ending', source_refs: ['s1'] }],
      world_rules: [{ id: 'w1', kind: 'constraint', label: '灯台の掟', summary: null, consequence: '夜の航路は灯守の許可なく使えない。', constrains: ['e1', 'ch2'], epistemic: 'canon', grade: 'A', spoiler: 'none', source_refs: ['s1'] }],
      setups: [{ id: 'su1', label: '古い地図の余白', meaning: '別の航路があり得ることを示す。', pays_off: ['e3'], epistemic: 'consensus', grade: 'B', spoiler: 'mid', source_refs: ['s1'] }],
      emotion_beats: [
        { id: 'eb1', phase: 'ph1', emotion: '不安', intensity: 3, label: '出港前の迷い', summary: null, evoked_by: ['e1'], epistemic: 'consensus', grade: 'B', spoiler: 'none', source_refs: ['s1'] },
        { id: 'eb2', phase: 'ph2', emotion: '安堵', intensity: 5, label: '航路が開ける', summary: '緊張が解ける。', evoked_by: ['e3'], epistemic: 'consensus', grade: 'B', spoiler: 'ending', source_refs: ['s1'] },
      ],
    },
    gaps: [{ module: 'M04', aspect_label: '回想の詳細な順序', reason: 'insufficient_sources' }],
    sources: [{ source_id: 's1', title: '架空の作品案内', publisher: '架空書房', url: 'https://example.invalid/bibliography/akari', accessed: '2026-01-02', tier: 'T1', license: '合成データ・実在の資料ではありません。' }],
  },
  {
    schema: 'sfsh-public/1',
    work: { work_id: 'anime-kumo-2021', title: 'クラウド工房', title_original: null, title_reading: 'くもこうぼう', aliases_display: ['雲の工房'], medium: 'anime', creators: [{ name: '架空 空', role: '監督' }], genres: ['sf', 'coming_of_age'], tags: [], status: 'ongoing', first_release_year: 2021, publisher: null, coverage_label: '第1期', spoiler_max: 'mid', has_matrix: false, first_published_at: '2026-02-01T00:00:00Z', updated_at: '2026-02-02T00:00:00Z' },
    phases: [{ id: 'ph1', label: '試作', order: 1 }, { id: 'ph2', label: '共同制作', order: 2 }],
    viz: { relations: { characters: [], relations: [], factions: [] }, reverse_plot: { trees: [] }, matrix: null, timeline: null },
    pages: { overview: [{ id: 'b1', heading: '空をつくる', paragraphs: ['雲を設計する工房で、若い技師たちが協働する架空の物語です。'], spoiler: 'none', based_on: [], epistemic: 'sfsh_analysis' }], figure_notes: { relations: null, reverse_plot: null, matrix: null }, themes: { intro: [], items: [] }, context: { intro: [], items: [], iconic: [] }, interpretations: { intro: [], items: [] }, quiz: [] },
    elements: { events: [], motives: [], arcs: [], world_rules: [], setups: [], emotion_beats: [] },
    gaps: [{ module: 'M05', aspect_label: '秘密の共有', reason: 'insufficient_sources' }], sources: [],
  },
];
export const ledgers: Work[] = [...fixtures.map(f => ({ id: f.work.work_id, title: f.work.title })), { id: 'novel-restricted-1999', title: '非公開専用の架空題名' }, { id: 'game-missing-2001', title: '生成前専用の架空題名' }].map((f, n) => ({
  work_id: f.id, title: f.title, title_original: null, title_reading: null, title_reading_basis: 'estimated', title_status: 'confirmed', title_source_ids: ['s1'],
  aliases: n === 0 ? [{ text: '灯路', kind: 'common', attested: true, source_ids: ['s1'], origin_job_id: 'fixture', first_seen: date }, { text: 'あかりのこおろ', kind: 'input', attested: false, source_ids: [], origin_job_id: 'fixture', first_seen: date }] : [],
  medium: fixtures[n]?.work.medium || 'other', creators: [], genres: [], tags: [], first_release_year: null, publish_mode: n === 2 ? 'Restricted' : 'Public', history: [], first_published_at: date, updated_at: date, created_at: date,
}));
