/**
 * §4.5 文字コード: UTF-8 (BOM allowed) strictly first, then CP932. Neither → the whole file is rejected.
 * Node's WHATWG "shift_jis" decoder is the Windows-31J (CP932) table (NEC / IBM extensions, ～ = U+FF5E, ① …),
 * verified against Python's cp932 codec when the fixtures were made.
 */
import type { BatchEncoding } from "./types.ts";

export type DecodeResult = { ok: true; encoding: BatchEncoding; text: string } | { ok: false; reason: string };

/** C0 controls other than TAB / LF / CR, DEL, and C1 controls (a C1 char only appears when garbage was decoded). */
const CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    // ignoreBOM: true → the BOM (if any) is kept in the output; we strip it ourselves so the label is exact.
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function decodeList(bytes: Uint8Array): DecodeResult {
  let encoding: BatchEncoding;
  let text: string | null = tryDecode("utf-8", bytes);
  if (text !== null) {
    if (text.startsWith("﻿")) {
      encoding = "utf-8-bom";
      text = text.slice(1);
    } else encoding = "utf-8";
  } else {
    text = tryDecode("shift_jis", bytes);
    if (text === null) return { ok: false, reason: "文字コードを解読できません（UTF-8 としても CP932 としても読めません）" };
    encoding = "cp932";
  }
  const m = text.match(CONTROL_RE);
  if (m) {
    const line = text.slice(0, m.index).split(/\r\n|\r|\n/).length;
    return { ok: false, reason: `制御文字 U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")} を含みます（${line}行目、${encoding} として解読）。テキストの一覧ではありません` };
  }
  return { ok: true, encoding, text };
}
