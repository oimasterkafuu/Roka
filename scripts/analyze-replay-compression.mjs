import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {inspectRpl,decodeRpl} from '../dist/rpl.js';
const directory=path.resolve(process.env.ROKA_DATA_DIR??'data','replays');
const limit=Number(process.argv.find(arg=>arg.startsWith('--limit='))?.slice(8)??Infinity);
for(const name of (await readdir(directory)).filter(name=>name.endsWith('.rpl')).sort().slice(0,limit)){
  const bytes=await readFile(path.join(directory,name));await decodeRpl(bytes);console.log(JSON.stringify({name,bytes:bytes.length,...inspectRpl(bytes)}));
}
