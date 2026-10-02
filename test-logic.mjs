// Run with: node test-logic.mjs
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const L = require('./logic.js');

let failed = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
}

console.log('\n== ?set= parameter ==');
check('?set=1', L.parseSetParam('?set=1'), 1);
check('?set=10', L.parseSetParam('?set=10'), 10);
check('?set=0', L.parseSetParam('?set=0'), 1);
check('?set=11', L.parseSetParam('?set=11'), 1);
check('?set=abc', L.parseSetParam('?set=abc'), 1);
check('missing', L.parseSetParam(''), 1);
check('?set=05 (leading zero)', L.parseSetParam('?set=05'), 1);
check('?set=2.5', L.parseSetParam('?set=2.5'), 1);
check('?set=-3', L.parseSetParam('?set=-3'), 1);
check('?set=7', L.parseSetParam('?set=7'), 7);

console.log('\n== Profanity matcher (blocked term or null) ==');
check('fuck', L.findBlocked('fuck'), 'fuck');
check('fucking', L.findBlocked('fucking'), 'fuck');
check('grape', L.findBlocked('grape'), null);
check('grapefruit', L.findBlocked('grapefruit'), null);
check('class', L.findBlocked('class'), null);
check('assist', L.findBlocked('assist'), null);
check('"kill you"', L.findBlocked('i will kill you'), 'kill you');
check('"skill your" (no false phrase hit)', L.findBlocked('improve the skill your team has'), null);
check('masked "f***"', L.findBlocked('what the f*** is this'), 'f***');
check('ass (exact)', L.findBlocked('you ass'), 'ass');
check('Fucking (capitalised, punctuation)', L.findBlocked('Fucking, hell!'), 'fuck');

console.log('\n== No sentence in any set trips the filter ==');
const hits = [];
for (const [set, list] of Object.entries(L.SENTENCE_SETS)) {
  list.forEach((s) => { const b = L.findBlocked(s); if (b) hits.push(`set ${set}: "${s}" -> ${b}`); });
}
check('all 50 sentences clean', hits, []);

console.log('\n== Sentence sets are well-formed ==');
const bad = [];
for (const [set, list] of Object.entries(L.SENTENCE_SETS)) {
  if (list.length !== 5) bad.push(`set ${set} has ${list.length} sentences`);
  list.forEach((s) => {
    const n = s.split(' ').length;
    if (!/^[a-z ]+$/.test(s)) bad.push(`set ${set}: non a-z: "${s}"`);
    if (n < 10 || n > 12) bad.push(`set ${set}: ${n} words: "${s}"`);
  });
}
check('10 sets x 5 sentences, a-z only, 10-12 words', bad, []);

console.log('\n== Sentence match ==');
const S = 'please open the door and turn on the light now';
const v = (transcript, error = null, supported = true) =>
  L.verifyClip({ supported, transcript, error, sentence: S });
check('exact', v(S), { outcome: 'upload', status: 'pass', score: 1, blocked: null });
check('exact, different case/punct', v('Please open the door, and turn on the light now.').outcome, 'upload');
check('partial (6/10 words)', v('please open the door and turn'), { outcome: 'upload', status: 'pass', score: 0.6, blocked: null });
check('partial below 50% (4/10)', v('please open the door'), { outcome: 'wrong', status: null, score: 0.4, blocked: null });
check('unrelated', v('the weather is nice today in chennai'), { outcome: 'wrong', status: null, score: 0.1, blocked: null });
check('empty, no error', v(''), { outcome: 'wrong', status: null, score: 0, blocked: null });
check('empty, no-speech error', v('', 'no-speech'), { outcome: 'wrong', status: null, score: 0, blocked: null });
check('empty, network error -> upload flagged', v('', 'network'), { outcome: 'upload', status: 'technical_error', score: null, blocked: null });
check('empty, audio-capture error -> upload flagged', v('', 'audio-capture').status, 'technical_error');
check('unsupported browser', v('', null, false), { outcome: 'upload', status: 'unsupported', score: null, blocked: null });
check('correct sentence + profanity -> blocked', v(S + ' fucking').outcome, 'blocked');
check('repeated word counted once per occurrence', L.matchScore('the cat the dog', 'the cat dog'), 0.75);

console.log('\n== Storage folder sanitising ==');
check('normal', L.folderName('21AD042', 'Priya S. Kumar'), '21ad042_priya_s_kumar');
check('path traversal attempt', L.folderName('../x', '../../etc'), 'x_etc');
check('accents', L.folderName('7', 'José Ñúñez'), '7_jose_nunez');
check('non-latin only', L.folderName('12', 'प्रिया'), '12_participant');

console.log(`\n${failed ? `${failed} FAILED` : 'All tests passed'}`);
process.exit(failed ? 1 : 0);
