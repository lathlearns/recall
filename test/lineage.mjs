/**
 * Recall — which summary a redo rebuilds on.
 *
 * A redo that rebuilds on the wrong summary is not comparable with its original,
 * and nothing says so: the two differ for a reason nobody chose.
 *
 * Run:  node test/lineage.mjs
 */

import { basisOf } from '../src/lineage.js';

const failures = [];
let checks = 0;

function check(label, actual, expected) {
    checks++;
    if (actual !== expected) {
        failures.push(`${label}: expected ${expected}, got ${actual}`);
    }
}

const id = s => s?.id ?? null;

// ── Recorded basis ───────────────────────────────────────────────────────────

{
    const a = { id: 'a', createdAt: 1, builtOn: null };
    const b = { id: 'b', createdAt: 2, builtOn: 'a' };
    const c = { id: 'c', createdAt: 3, builtOn: 'a' };  // made while a was active again
    const all = [a, b, c];
    check('recorded basis wins over creation order', id(basisOf(c, all)), 'a');
    check('recorded null means nothing', id(basisOf(a, all)), null);
}

{
    // b was built on a; a was redone as a2 and then deleted.
    const a2 = { id: 'a2', createdAt: 3, regeneratedFrom: 'a', builtOn: null };
    const b = { id: 'b', createdAt: 2, builtOn: 'a' };
    check('deleted basis falls to the redo that replaced it', id(basisOf(b, [b, a2])), 'a2');
}

{
    const z = { id: 'z', createdAt: 1, builtOn: null };
    const b = { id: 'b', createdAt: 2, builtOn: 'gone' };
    check('deleted basis with no redo falls back to derivation', id(basisOf(b, [z, b])), 'z');
}

// ── Records written before builtOn ───────────────────────────────────────────

{
    const a = { id: 'a', createdAt: 1 };
    const b = { id: 'b', createdAt: 2 };
    const b2 = { id: 'b2', createdAt: 3, regeneratedFrom: 'b' };
    const b3 = { id: 'b3', createdAt: 4, regeneratedFrom: 'b2' };
    const all = [a, b, b2, b3];
    check('plain chain', id(basisOf(b, all)), 'a');
    check('redo shares its original\'s basis', id(basisOf(b2, all)), 'a');
    check('redo of a redo shares it too', id(basisOf(b3, all)), 'a');
    check('first summary has none', id(basisOf(a, all)), null);
}

{
    // The original of a redo chain was deleted; its siblings still belong together.
    const a = { id: 'a', createdAt: 1 };
    const b2 = { id: 'b2', createdAt: 3, regeneratedFrom: 'b' };
    const b3 = { id: 'b3', createdAt: 4, regeneratedFrom: 'b' };
    const all = [a, b2, b3];
    check('siblings of a deleted original skip each other', id(basisOf(b3, all)), 'a');
}

{
    const a = { id: 'a', createdAt: 1, regeneratedFrom: 'b' };
    const b = { id: 'b', createdAt: 2, regeneratedFrom: 'a' };
    check('a corrupt cycle does not hang', id(basisOf(a, [a, b])), null);
}

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log(`All ${checks} lineage checks pass.`);
