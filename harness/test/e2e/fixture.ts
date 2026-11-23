/**
 * Job e2e fixture: an invented work 『星降る灯台の記録』 (novel, 2001) served by a local node:http server.
 * All titles, people and texts are original fiction written for this test.
 */
import { createServer } from "node:http";

export const TITLE = "星降る灯台の記録";
export const READING = "ほしふる とうだい の きろく";
export const CREATOR = "汐見遥";
export const INPUT_QUERY = "星降る灯台";

export interface ClaimDef {
  tag: string;
  text: string;
  /** Verbatim substring of the page body (evidence_quote). */
  quote: string;
  aspects: string[];
  epistemic?: "canon" | "consensus" | "fan_theory";
  phase?: "early" | "middle" | "end" | "whole" | "unknown";
  spoiler?: "none" | "mid" | "ending";
  entities?: string[];
}

export interface PageDef {
  path: string;
  title: string;
  body: string[];
  claims: ClaimDef[];
}

export const PAGES: Record<string, PageDef> = {
  official: {
    path: "/official/",
    title: "星降る灯台の記録｜潮騒書房",
    body: [
      `『${TITLE}』は${CREATOR}による長編小説で、2001年に潮騒書房から刊行されました。`,
      "北の小島を舞台に、灯台守の少女・朝凪ミオと島の人々を描く群像劇です。",
    ],
    claims: [
      { tag: "o1", text: "汐見遥が書いた長編で、版元は潮騒書房、刊行は2001年。", quote: `${CREATOR}による長編小説`, aspects: ["bibliographic"], phase: "whole", entities: [CREATOR, "潮騒書房"] },
      { tag: "o2", text: "主人公は小島の灯台を守る少女ミオである。", quote: "灯台守の少女・朝凪ミオ", aspects: ["M01"], phase: "whole", entities: ["朝凪ミオ"] },
      { tag: "o3", text: "一人の主人公だけでなく島の住民たちを並行して描く作品とされる。", quote: "島の人々を描く群像劇", aspects: ["genre"], phase: "whole" },
    ],
  },
  library: {
    path: "/library/record.html",
    title: "書誌詳細 - 架空図書館データベース",
    body: [`書名：${TITLE}（${READING}）`, `著者：${CREATOR}`, "出版者：潮騒書房", "出版年：2001年", "形態：単行本 318ページ"],
    claims: [{ tag: "l1", text: "書誌データベースでも初版は2001年、版元は潮騒書房と記録されている。", quote: "出版年：2001年", aspects: ["bibliographic", "title"], phase: "whole" }],
  },
  encyclopedia: {
    path: "/wiki/hoshifuru.html",
    title: "星降る灯台の記録 - 架空百科",
    body: [
      `${TITLE}は、${CREATOR}の小説。`,
      "主人公の朝凪ミオは幼くして両親を失い、老灯台守の久遠に育てられた。",
      "ある年、星が降る夜になると灯台の灯が消えるという異変が起こる。",
      "同じころ測量士の灰原が島を訪れ、ミオとともに異変を調べ始める。",
      "二人は過去の記録をたどり、灯が消える夜の共通点を探していく。",
      "最後にミオは自らの手で灯をともし、島に光が戻る。",
    ],
    claims: [
      { tag: "e1", text: "ミオは身寄りを失った後、年老いた灯台守の久遠のもとで成長した。", quote: "老灯台守の久遠に育てられ", aspects: ["M01"], phase: "early", entities: ["朝凪ミオ", "久遠"] },
      { tag: "e2", text: "外から来た測量士の灰原が、ミオと組んで異変の調査にあたる。", quote: "測量士の灰原が島を訪れ", aspects: ["M01", "M03"], phase: "early", entities: ["灰原", "朝凪ミオ"] },
      { tag: "e3", text: "流星の夜ごとに灯台の明かりが途絶えることが物語の発端になる。", quote: "星が降る夜になると灯台の灯が消える", aspects: ["M03"], phase: "early" },
      { tag: "e4", text: "異変の手掛かりを求め、二人は昔の灯台日誌を読み返す。", quote: "二人は過去の記録をたどり", aspects: ["M03"], phase: "middle", entities: ["朝凪ミオ", "灰原"] },
      { tag: "e5", text: "結末でミオ自身が明かりを再点火し、島は光を取り戻す。", quote: "最後にミオは自らの手で灯をともし", aspects: ["M02", "M03"], phase: "end", spoiler: "ending", entities: ["朝凪ミオ"] },
    ],
  },
  critic: {
    path: "/review/critic.html",
    title: "書評：星降る灯台の記録",
    body: [
      `${TITLE}が描くのは、記憶を受け継ぐことの重さである。`,
      "本作は第12回潮騒文学賞を受賞した。",
      "抑制された文体が高く評価され、多くの書評で取り上げられた。",
      "登場人物たちは孤独と共同体のあいだで揺れ動く。",
    ],
    claims: [
      { tag: "r1", text: "前の世代の記憶を引き継ぐ負担が中心的な問いだと評者は読む。", quote: "記憶を受け継ぐことの重さ", aspects: ["M10"], epistemic: "consensus", phase: "whole" },
      { tag: "r2", text: "この小説は潮騒文学賞（第12回）の受賞作である。", quote: "第12回潮騒文学賞を受賞", aspects: ["M12"], phase: "whole", entities: ["潮騒文学賞"] },
      { tag: "r3", text: "控えめな語り口が批評家から好意的に受け止められた。", quote: "抑制された文体が高く評価", aspects: ["M12"], epistemic: "consensus", phase: "whole" },
      { tag: "r4", text: "人物は一人でいることと島の輪に加わることの間で迷う。", quote: "孤独と共同体のあいだ", aspects: ["M10"], epistemic: "consensus", phase: "whole" },
    ],
  },
  interview: {
    path: "/interview/author.html",
    title: "作家インタビュー 汐見遥",
    body: [
      `${CREATOR}は語る。「ミオは久遠との約束を守りたい一心で灯台に残ります」。`,
      "「灰原は、島が地図から消えることを恐れて測量を急いでいるのです」。",
      "「この物語の芯にあるのは、忘れられることへの抵抗です」。",
      "「ミオは守られる側から守る側へと変わっていきます」。",
    ],
    claims: [
      { tag: "i1", text: "ミオが灯台にとどまるのは、育ての親と交わした約束のためだと作者は説明する。", quote: "久遠との約束を守りたい", aspects: ["M06"], phase: "whole", entities: ["朝凪ミオ", "久遠"] },
      { tag: "i2", text: "灰原の焦りの根には、島が公式の地図から外される不安がある。", quote: "島が地図から消えることを恐れて", aspects: ["M06"], phase: "middle", entities: ["灰原"] },
      { tag: "i3", text: "作者によれば、物語の中心は忘却に抗うことにある。", quote: "忘れられることへの抵抗", aspects: ["M10", "M06"], phase: "whole" },
      { tag: "i4", text: "ミオは保護される立場から島を支える立場へ移っていく。", quote: "守られる側から守る側へ", aspects: ["M07"], phase: "whole", entities: ["朝凪ミオ"] },
    ],
  },
  guide: {
    path: "/notes/reader-guide.html",
    title: "読書ガイド：星降る灯台の記録",
    body: [
      `${TITLE}の読みどころをまとめる。`,
      "久遠が倒れたことで、ミオはひとりで灯台を任されることになる。",
      "測量の結果が異変の手がかりとなり、灯が消える理由が見えてくる。",
      "終盤、島の人々が油を持ち寄ったことで再点灯が実現する。",
      "2010年に舞台化され、各地で上演された。",
      "はじめは反発しあっていた二人も、やがて互いを信頼するようになる。",
    ],
    claims: [
      { tag: "n1", text: "育ての親が病に倒れ、ミオは独りで灯台の責任を負う。", quote: "久遠が倒れたことで", aspects: ["M02"], phase: "middle", spoiler: "mid", entities: ["久遠", "朝凪ミオ"] },
      { tag: "n2", text: "灰原の測った数値が、明かりが途絶える原因の解明につながる。", quote: "測量の結果が異変の手がかりとなり", aspects: ["M03"], phase: "middle", entities: ["灰原"] },
      { tag: "n3", text: "住民が燃料を出し合ったからこそ、最後の再点火が可能になった。", quote: "島の人々が油を持ち寄った", aspects: ["M02"], phase: "end", spoiler: "ending" },
      { tag: "n4", text: "2010年に舞台版が作られ、複数の土地で公演された。", quote: "2010年に舞台化", aspects: ["M12"], phase: "whole" },
      { tag: "n5", text: "ミオと灰原は当初ぶつかるが、のちに信頼関係を築く。", quote: "反発しあっていた二人", aspects: ["M01"], phase: "middle", entities: ["朝凪ミオ", "灰原"] },
    ],
  },
  essay: {
    path: "/essay/ending.html",
    title: "エッセイ：灯の意味を考える",
    body: [`${TITLE}の結末について考える。`, "灯は記憶そのものの比喩だと読む人も多い。", "灰原の測量は、島を記録に残す行為でもあった。"],
    claims: [
      { tag: "x1", text: "灯台の明かりを記憶の象徴とみなす読み方がファンの間にある。", quote: "灯は記憶そのものの比喩", aspects: ["M10"], epistemic: "fan_theory", phase: "whole" },
      { tag: "x2", text: "灰原が測量するのは島の存在を書き残すためでもあるという見方。", quote: "島を記録に残す行為", aspects: ["M06"], epistemic: "fan_theory", phase: "whole", entities: ["灰原"] },
    ],
  },
  fan1: { path: "/blog/fan1.html", title: "ファンブログ1", body: [`${TITLE}の感想（その1）。`, "ミオがかっこいい。"], claims: [] },
  fan2: { path: "/blog/fan2.html", title: "ファンブログ2", body: [`${TITLE}の感想（その2）。`, "灰原の過去が気になる。"], claims: [] },
};

function html(p: PageDef): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${p.title}</title><meta property="og:site_name" content="e2e-local"></head>`
    + `<body><nav>メニュー</nav><main>${p.body.map((b) => `<p>${b}</p>`).join("")}</main><footer>フッター</footer></body></html>`;
}

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4f20000000049454e44ae426082", "hex");

export interface E2EServer {
  base: string;
  /** Every request path, in order. */
  requests: string[];
  close(): Promise<void>;
}

export async function startServer(): Promise<E2EServer> {
  const requests: string[] = [];
  const byPath = new Map(Object.values(PAGES).map((p) => [p.path, p]));
  const server = createServer((req, res) => {
    const p = (req.url ?? "/").split("?")[0];
    requests.push(p);
    if (p === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/\n");
    } else if (byPath.has(p)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html(byPath.get(p)!));
    } else if (p === "/private/secret.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<title>secret</title><main>${TITLE}の非公開メモ</main>`);
    } else if (p === "/pirate/raw.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<title>raw</title><main>${TITLE} 全文</main>`);
    } else if (p === "/cover.png") {
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": PNG.length });
      res.end(PNG);
    } else {
      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<title>404</title><main>not found</main>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  return {
    base: `http://127.0.0.1:${addr.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
