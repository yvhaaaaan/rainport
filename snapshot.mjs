import fs from 'node:fs';
import path from 'node:path';

// Copy a closed local node, preserving LevelDB bytes and the associated race files together.
export function copySnapshot(source, target) {
  fs.mkdirSync(target, {recursive:true});
  for (const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const from=path.join(source,entry.name), to=path.join(target,entry.name);
    if (entry.isDirectory()) copySnapshot(from,to);
    else if (entry.isFile()) fs.writeFileSync(to,fs.readFileSync(from));
  }
}
