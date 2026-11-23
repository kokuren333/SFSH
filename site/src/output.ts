// The single write boundary. The harness creates the root before applying permissions.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
export function createOutput(root: string): (rel: string, content: string) => void {
  root = resolve(root);
  return (rel, content) => {
    const target = resolve(root, rel), r = relative(root, target);
    if (!r || r === '..' || r.startsWith('..\\') || r.startsWith('../') || isAbsolute(r)) throw new Error('Output path outside output directory');
    if (dirname(target) !== root) mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content.replace(/\r\n?/g, '\n').replace(/\n*$/, content ? '\n' : ''), 'utf8');
  };
}
