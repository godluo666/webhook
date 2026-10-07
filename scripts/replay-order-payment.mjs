import {readFile} from 'node:fs/promises';
import {replayOrderPayment} from '../lib/order-replay.js';

if(process.argv.length!==3)throw new Error('用法：node scripts/replay-order-payment.mjs 脱敏回放文件.json');
const input=JSON.parse(await readFile(process.argv[2],'utf8'));
console.log(JSON.stringify(await replayOrderPayment(input),null,2));
