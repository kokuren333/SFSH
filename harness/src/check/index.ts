/** S4 automatic check (§5.1 A-1 / A-2, §5.2 advisory). */
export { autoCheck, recheckPublic, detectA1, stripA2, AUTOCHECK_STAGE, S4_TIMEOUT_MS } from "./stage.ts";
export { buildNotice, formatNotice, ADVISORY_LABELS } from "./notice.ts";
export { scanDist, sanitizeDist, applyA2ToDist, type DistFinding, type DistA2Report } from "./dist.ts";
export { stripMedia, MEDIA_EXTENSIONS } from "./a2.ts";
export { A1_REWRITE_SCHEMA } from "./a1.ts";
export * from "./types.ts";
