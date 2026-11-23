/**
 * S3 generation stages (REQUIREMENTS §2.6, §3.2 S3 row, §6.5). Each is (ctx: StageContext) => Promise<StageResult>.
 * Intended order: suggestTags → projectPublic → writePages → composePublic
 * (projectPublic / composePublic re-read gen/tags.json, so tags may also be (re)run later and composed again).
 */
export { suggestTags } from "./tags.ts";
export { projectPublic, buildProjection } from "./project.ts";
export { writePages } from "./write.ts";
export { composePublic, composePublicWork } from "./compose.ts";
export { checkPublicWork, forbiddenContent } from "./check.ts";
export { GEN_FILES } from "./io.ts";
