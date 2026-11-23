/**
 * Application-command definition for `/sfsh` (REQUIREMENTS §4.2 + `/sfsh answer`, PLAN §4).
 * `sfsh discord register` PUTs this array (gated by assertProductionAllowed); tests only PUT it to the mock.
 * Discord rules honoured: lowercase names ≤32, descriptions ≤100, required options before optional ones.
 */
import { NOTE_MAX, WORK_QUERY_MAX } from "../queue/request.ts";

export const OPT = { SUB_COMMAND: 1, STRING: 3, INTEGER: 4, ATTACHMENT: 11 } as const;

export interface CommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  min_value?: number;
  max_value?: number;
  min_length?: number;
  max_length?: number;
  options?: CommandOption[];
}

export interface ApplicationCommand {
  name: string;
  type: number;
  description: string;
  options: CommandOption[];
}

const str = (name: string, description: string, required = false, max_length?: number): CommandOption => ({
  type: OPT.STRING,
  name,
  description,
  ...(required ? { required: true } : {}),
  ...(max_length ? { max_length } : {}),
});
const sub = (name: string, description: string, options: CommandOption[] = []): CommandOption => ({ type: OPT.SUB_COMMAND, name, description, options });

const REASON_MAX = 500;

export const SFSH_COMMAND: ApplicationCommand = {
  name: "sfsh",
  type: 1, // CHAT_INPUT
  description: "SFSH への指示（受付・状態・取消・差し止め）",
  options: [
    sub("request", "作品の解説ページ作成を依頼する", [
      str("work", "作品名", true, WORK_QUERY_MAX),
      str("range", "範囲（例: 全体 / 1-3巻 / 1-12話 / 第2シーズン / 「無限列車」編 / 劇場版）", true, 100),
      str("medium", "媒体のヒント（manga / anime / novel など）", false, 40),
      str("note", "メモ", false, NOTE_MAX),
    ]),
    sub("import", "タイトル一覧（.txt / .csv）を一括投入する", [
      { type: OPT.ATTACHMENT, name: "file", description: "タイトル一覧のファイル（.txt または .csv）", required: true },
      str("range", "行に範囲が無いときの既定の範囲", false, 100),
      str("medium", "行に媒体が無いときの既定の媒体", false, 40),
    ]),
    sub("status", "ジョブまたはバッチの状態（省略時は全体の概要）", [str("id", "job_id または batch_id", false, 64)]),
    sub("queue", "待ち行列を表示する"),
    sub("cancel", "未完了のジョブ（またはバッチ）を取り消す（投入者・オーナー）", [str("job_id", "取り消す job_id", false, 64), str("batch_id", "取り消す batch_id", false, 64)]),
    sub("answer", "聞き返し中のジョブに回答する", [
      str("job_id", "回答するジョブの job_id", true, 64),
      { type: OPT.INTEGER, name: "pick", description: "候補の番号（1から）", min_value: 1, max_value: 50 },
      str("work", "作品名を言い直す", false, WORK_QUERY_MAX),
      str("medium", "媒体のヒント", false, 40),
      str("range", "範囲を言い直す", false, 100),
    ]),
    sub("hold", "作品を差し止める（オーナーのみ）", [str("work", "work_id", true, 128), str("reason", "理由", true, REASON_MAX)]),
    sub("release", "差し止めを解除する（オーナーのみ）", [str("work", "work_id", true, 128)]),
    sub("takedown", "作品を取り下げる（オーナーのみ）", [str("work", "work_id", true, 128), str("reason", "理由", true, REASON_MAX)]),
  ],
};

/** The array PUT to /applications/{id}[/guilds/{gid}]/commands (bulk overwrite). */
export function commandDefinitions(): ApplicationCommand[] {
  return [SFSH_COMMAND];
}

export const SUBCOMMANDS = SFSH_COMMAND.options.map((o) => o.name);
export const OWNER_ONLY_SUBCOMMANDS = ["hold", "release", "takedown"] as const;
