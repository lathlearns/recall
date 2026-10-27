/**
 * Recall — fitting the hard cutoff to the room a request leaves.
 *
 * Some APIs refuse a request whose input plus `max_tokens` runs past the context
 * window. The buffer is sized against the reserve, not the cutoff, so a long chat
 * can ask for a reply bigger than the window has left. Each request is fitted
 * instead; what matters is that a short chat still gets the whole cutoff, a long
 * one gets exactly the room there is, and "no cutoff" stays no cutoff. When it was
 * lowered, what the user is told to do about it fits the run.
 *
 * Run:  node test/output-limit.mjs
 */

import { fitOutputLimit, roomRemedy } from '../src/util.js';

const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

// A 128,000 window, 5,000 reserved, a 20,000 cutoff.
check('short chat keeps the whole cutoff', fitOutputLimit(20000, 98000), { limit: 20000, lowered: false });
check('exactly enough room is not lowered', fitOutputLimit(20000, 20000), { limit: 20000, lowered: false });
check('long chat gets the room there is', fitOutputLimit(20000, 9000), { limit: 9000, lowered: true });
check('a full buffer still leaves the reserve', fitOutputLimit(20000, 5000), { limit: 5000, lowered: true });
check('fractional room rounds down, never over', fitOutputLimit(20000, 8999.7), { limit: 8999, lowered: true });
check('no cutoff stays no cutoff', fitOutputLimit(0, 9000), { limit: 0, lowered: false });
check('a blank cutoff is no cutoff', fitOutputLimit('', 9000), { limit: 0, lowered: false });
check('no room still asks for a token, not 0 (= unlimited)', fitOutputLimit(20000, 0), { limit: 1, lowered: true });

// When the limit was lowered, the advice is what makes room for that run — never
// a rebuild for a run that is one, and never the cutoff, which was not the limit.
const fixes = ['summarize', 'regenerate', 'rebuild'].map(kind => roomRemedy(kind).fix);
check('each run gets its own advice', new Set(fixes).size, 3);
check('Summarize now points at batches', /Rebuild button/.test(fixes[0]), true);
check('a redo does not point at Rebuild', /Rebuild/.test(fixes[1]), false);
check('a rebuild points at the reserve, not at Rebuild', [/Reserved for the summary/.test(fixes[2]), /Rebuild/.test(fixes[2])], [true, false]);
check('none says to raise the cutoff', fixes.some(fix => /Hard cutoff/i.test(fix)), false);

if (failures.length) {
    console.error(failures.join('\n'));
    process.exit(1);
}
console.log('All 13 output-limit checks pass.');
