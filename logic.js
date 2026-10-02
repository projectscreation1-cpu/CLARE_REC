// Pure logic shared by the browser app and the Node test script (test-logic.mjs).
// No DOM access in this file.
(function (root) {
  'use strict';

  const SENTENCE_SETS = {
    1: [
      'please open the door and turn on the light now',
      'she walked slowly to the market to buy some fruit',
      'we all watched a movie together at home last night',
      'he forgot his phone at the office again this morning',
      'the children were playing happily in the garden this morning',
    ],
    2: [
      'can you please help me carry these heavy boxes upstairs',
      'my brother is cooking rice and vegetables for our dinner',
      'she quickly finished her homework before going out to play',
      'the weather today is bright warm and very pleasant outside',
      'let us meet at the library after our lunch break today',
    ],
    3: [
      'he always wakes up early to go for a morning run',
      'the teacher explained the lesson clearly to all the students',
      'she bought a new dress for the upcoming family wedding',
      'we need to finish this project before the deadline arrives',
      'the dog barked loudly when the stranger knocked the door',
    ],
    4: [
      'please remember to bring your umbrella since it might rain',
      'the children enjoyed their trip to the zoo last weekend',
      'he studies every evening to prepare for his final exams',
      'she planted colorful flowers in the garden behind her house',
      'we should leave early today to avoid the heavy traffic jam',
    ],
    5: [
      'the chef prepared a delicious meal for all the guests today',
      'my friend called me last night to share good news',
      'the students submitted all their assignments before the given deadline',
      'she practices singing every day to improve her natural voice',
      'the farmer worked hard in the field throughout the whole day',
    ],
    6: [
      'he repaired the broken chair using some tools from home',
      'the little baby slept peacefully throughout the entire long night',
      'she decorated the whole house beautifully for the festival celebration',
      'the manager quickly scheduled an important meeting for tomorrow morning',
      'they traveled together to the mountains during the summer vacation',
    ],
    7: [
      'the librarian helped me find the book i wanted quickly today',
      'he saved enough money to buy a brand new bicycle',
      'she wrote a long letter to her grandmother living abroad',
      'the players practiced very hard before the important championship match',
      'we enjoyed a peaceful walk along the beach this evening',
    ],
    8: [
      'the nurse checked on the patient every hour through the night',
      'he fixed the leaking tap in the kitchen this morning',
      'she taught her younger brother how to ride a bicycle',
      'the artist painted a beautiful scene of the setting sun',
      'they planned a surprise party for their close friend today',
    ],
    9: [
      'the coach motivated the team before the final big match',
      'she carefully arranged the books on the wooden library shelf',
      'he answered every single question during the interview with confidence',
      'the workers finished building the new bridge ahead of schedule',
      'we celebrated her birthday with cake and many colorful balloons',
    ],
    10: [
      'the pilot announced that the flight would land safely very soon',
      'she cleaned her room before her relatives arrived for dinner',
      'he practiced his speech many times before the school event',
      'the gardener watered all the plants early in the morning',
      'they watched the fireworks together during the new year celebration',
    ],
  };

  // Accepts only the exact strings "1".."10"; anything else falls back to set 1.
  function parseSetParam(search) {
    const raw = new URLSearchParams(search || '').get('set');
    if (raw !== null && /^(?:[1-9]|10)$/.test(raw.trim())) return Number(raw.trim());
    return 1;
  }

  // Lowercase, keep a-z/0-9/apostrophes, everything else becomes a space.
  function tokenize(text) {
    return String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9'*]+/g, ' ')
      .split(' ')
      .map((w) => w.replace(/^'+|'+$/g, ''))
      .filter(Boolean);
  }

  // Fraction of the sentence's words found in the transcript (multiset match,
  // so a word repeated in the sentence must be spoken that many times).
  function matchScore(sentence, transcript) {
    const target = tokenize(sentence);
    if (!target.length) return 0;
    const bag = new Map();
    for (const w of tokenize(transcript)) bag.set(w, (bag.get(w) || 0) + 1);
    let hits = 0;
    for (const w of target) {
      const n = bag.get(w) || 0;
      if (n > 0) { hits++; bag.set(w, n - 1); }
    }
    return hits / target.length;
  }

  // Blocked if a spoken word STARTS WITH one of these ("fucking" -> "fuck").
  // Never substring matching, so "grape" does not hit "rape".
  const PREFIX_BLOCK = [
    'fuck', 'motherfuck', 'shit', 'bullshit', 'bitch', 'cunt', 'asshole',
    'bastard', 'dickhead', 'wanker', 'whore', 'slut', 'rape', 'nigg',
    'faggot', 'retard', 'chutiya', 'madarchod', 'behenchod', 'bhenchod', 'bhosdi',
  ];
  // Short words that would cause false positives as prefixes
  // ("ass" -> "assist", "assignments"), so they must match the whole word.
  const EXACT_BLOCK = ['ass', 'arse', 'arsehole', 'dick', 'dicks', 'cock', 'cocks', 'tits', 'prick', 'piss', 'fag', 'fags'];
  // Multi-word phrases, matched on whole-word boundaries.
  const PHRASE_BLOCK = ['kill you', 'kill yourself', 'kill myself', 'i will kill', 'go die'];

  // Returns the matched blocked term, or null.
  function findBlocked(transcript) {
    const words = tokenize(transcript);
    for (const w of words) {
      // Chrome's recognizer masks profanity as "f***", "s***".
      if (/^[a-z]\*+[a-z]*$/.test(w)) return w;
      const clean = w.replace(/[^a-z]/g, '');
      if (!clean) continue;
      if (EXACT_BLOCK.includes(clean)) return clean;
      const p = PREFIX_BLOCK.find((b) => clean.startsWith(b));
      if (p) return p;
    }
    const joined = ' ' + words.join(' ') + ' ';
    const phrase = PHRASE_BLOCK.find((ph) => joined.includes(' ' + ph + ' '));
    return phrase || null;
  }

  // Decides what happens to a finished clip.
  //   outcome: 'upload' | 'blocked' | 'wrong'
  //   status (metadata verificationStatus): 'pass' | 'technical_error' | 'unsupported'
  function verifyClip({ supported, transcript, error, sentence }) {
    const text = String(transcript || '').trim();
    if (!supported) {
      return { outcome: 'upload', status: 'unsupported', score: null, blocked: null };
    }
    const blocked = text ? findBlocked(text) : null;
    if (blocked) return { outcome: 'blocked', status: null, score: matchScore(sentence, text), blocked };
    if (!text && error && error !== 'no-speech') {
      return { outcome: 'upload', status: 'technical_error', score: null, blocked: null };
    }
    const score = matchScore(sentence, text);
    if (score >= 0.5) return { outcome: 'upload', status: 'pass', score, blocked: null };
    return { outcome: 'wrong', status: null, score, blocked: null };
  }

  // Letters, digits and underscore only, for storage paths.
  function sanitize(s) {
    return String(s || '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .toLowerCase();
  }

  function folderName(rollNo, name) {
    return `${sanitize(rollNo) || 'noid'}_${sanitize(name) || 'participant'}`;
  }

  const api = { SENTENCE_SETS, parseSetParam, tokenize, matchScore, findBlocked, verifyClip, sanitize, folderName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ClarusLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
