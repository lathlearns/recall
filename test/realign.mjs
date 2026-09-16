/**
 * Recall — choosing the active summary for the chat actually loaded.
 *
 * Branching copies the whole summary archive and the active pointer, then
 * truncates the chat to the branch point. The pointer then names a summary
 * describing events that happened only in the branch you left — and the macro
 * resolves its text regardless, so the model is handed memory of a future that
 * was abandoned. Nothing throws; it just quietly remembers wrong.
 *
 * The opposite mistake costs as much in the other direction: moving the pointer
 * when it was fine discards a summary the user chose.
 *
 * Run:  node test/realign.mjs
 */

import { chooseActiveSummary } from '../src/realign.js';

const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

/** @param {object} fields */
const summary = fields => ({ stale: false, ...fields });

// A chat summarised three times, the archive as a branch would inherit it.
const archive = [
    summary({ id: 'early', coversTo: 40, createdAt: 100 }),
    summary({ id: 'middle', coversTo: 90, createdAt: 200 }),
    summary({ id: 'late', coversTo: 180, createdAt: 300 }),
];

// 1. The ordinary case: the chat is whole and the pointer is right.
check('a fitting summary is left alone',
    chooseActiveSummary(archive, 'late', 200), { moved: false, id: 'late' });

// 2. Branched below the newest summary's coverage.
check('a branch falls back to the newest that fits',
    chooseActiveSummary(archive, 'late', 100), { moved: true, id: 'middle' });

// 3. Branched below that one too.
check('and keeps falling back',
    chooseActiveSummary(archive, 'late', 60), { moved: true, id: 'early' });

// 4. Branched before any summary. The pointer clears rather than naming
//    something untrue — which is also what lets the built-in's stored summary
//    stand in, since that is read from the messages themselves.
check('nothing fits, so the pointer clears',
    chooseActiveSummary(archive, 'late', 20), { moved: true, id: null });

// 5. Newest by creation time, not by position in the array or by coverage. An
//    archive is appended to in generation order, but a redo of an old summary
//    lands at the end with a recent timestamp and old coverage.
{
    const jumbled = [
        summary({ id: 'newer-but-first', coversTo: 50, createdAt: 900 }),
        summary({ id: 'older-but-last', coversTo: 80, createdAt: 100 }),
        summary({ id: 'branched-away', coversTo: 500, createdAt: 1000 }),
    ];
    check('picks by createdAt, not array order',
        chooseActiveSummary(jumbled, 'branched-away', 90).id, 'newer-but-first');
}

// 6. Stale summaries are not promoted. Their anchor is gone or changed, so their
//    coverage no longer means what it says — trading a wrong summary for an
//    untrustworthy one is not an improvement.
{
    const withStale = [
        summary({ id: 'good', coversTo: 40, createdAt: 100 }),
        summary({ id: 'broken', coversTo: 90, createdAt: 200, stale: true }),
        summary({ id: 'gone', coversTo: 180, createdAt: 300 }),
    ];
    check('a stale summary is skipped', chooseActiveSummary(withStale, 'gone', 100).id, 'good');
}

// 7. Coverage exactly at the last message still fits. Off by one here would
//    discard a summary on every branch taken at its own anchor.
check('coverage ending on the last message fits',
    chooseActiveSummary([summary({ id: 'exact', coversTo: 99, createdAt: 1 })], 'exact', 100),
    { moved: false, id: 'exact' });
check('coverage one past the end does not',
    chooseActiveSummary([summary({ id: 'over', coversTo: 100, createdAt: 1 })], 'over', 100),
    { moved: true, id: null });

// 8. Nothing to do, in the several ways there can be nothing to do.
check('no active pointer', chooseActiveSummary(archive, null, 200), { moved: false, id: null });
check('an unknown pointer', chooseActiveSummary(archive, 'ghost', 200), { moved: false, id: 'ghost' });
check('an empty archive', chooseActiveSummary([], 'late', 200), { moved: false, id: 'late' });

// An empty chat is a chat that has not loaded, not evidence a summary is wrong.
// Acting on it would clear the pointer on every reload.
check('an empty chat changes nothing', chooseActiveSummary(archive, 'late', 0), { moved: false, id: 'late' });

// 9. Junk in the archive must not throw or be chosen.
{
    const messy = [null, summary({ id: 'ok', coversTo: 10, createdAt: 5 }), { id: 'no-coverage' }];
    check('malformed records are ignored', chooseActiveSummary(messy, 'ghost-active', 50), { moved: false, id: 'ghost-active' });
    check('and are not promoted', chooseActiveSummary(messy, 'no-coverage', 50).id, 'ok');
}

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All 14 branch-realignment checks pass.');
