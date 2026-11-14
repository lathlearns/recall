/**
 * Recall — cutting a batch to fit, and sizing live text, without a tokenizer
 * request for every piece.
 *
 * Both replace requests: a rebuild of a long chat used to ask the tokenizer for
 * one count per message, and the live pane for a recount of the growing text
 * every second. What stands in for them is arithmetic on lengths, and the ways it
 * goes wrong are quiet. A cut that trusts its estimate sends a request that is
 * over the limit, or gives up on a batch that fits; one that averages the whole
 * request's density drops most of a Japanese chat sitting under English
 * reference material. So the cut is checked against a stand-in tokenizer whose
 * real sizes are known, including one where the two halves differ fourfold.
 *
 * Run:  node test/sizing.mjs
 */

import { cutToFit, createEstimator } from '../src/sizing.js';

const failures = [];
let checks = 0;

function check(label, actual, expected) {
    checks++;
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

function ok(label, condition, detail = '') {
    checks++;
    if (!condition) {
        failures.push(`${label}${detail ? `: ${detail}` : ''}`);
    }
}

/**
 * A request whose real size is known: a fixed part, plus messages of `sizes`
 * characters at `perChar` tokens each. Counts how often it is measured.
 */
function request({ fixed, sizes, perChar }) {
    const real = count => fixed + sizes.slice(0, count).reduce((a, b) => a + b, 0) * perChar;
    const asked = [];
    return {
        sizes,
        fixed,
        used: real(sizes.length),
        real,
        asked,
        measure: async count => {
            asked.push(count);
            return real(count);
        },
        /** The most messages that really fit. */
        best: available => {
            let count = sizes.length;
            while (count > 0 && real(count) > available) {
                count--;
            }
            return count;
        },
    };
}

const even = n => Array.from({ length: n }, () => 1000);

// 1. Everything fits: nothing is cut and nothing is measured.
{
    const r = request({ fixed: 5000, sizes: even(50), perChar: 0.25 });
    check('a batch that fits is left whole', await cutToFit({ ...r, available: 20000 }), 50);
    check('and is not measured again', r.asked, []);
}

// 2. An ordinary overflow: the cut is the most that fits, found in one measurement.
{
    const r = request({ fixed: 5000, sizes: even(200), perChar: 0.25 });
    const fits = await cutToFit({ ...r, available: 30000 });
    check('an even batch is cut to the most that fits', fits, r.best(30000));
    ok('what it settles on was measured and fits', r.real(fits) <= 30000);
    check('in one measurement, not one per message', r.asked.length, 1);
}

// 3. The fixed part and the chat in different languages. English reference
//    material at 4 characters a token, a chat at 1: averaging the two would ask
//    for more characters to go than the chat has.
{
    const r = request({ fixed: 60000, sizes: Array.from({ length: 80 }, () => 1000), perChar: 1 });
    const fits = await cutToFit({ ...r, available: 100000 });
    check('a dense chat under sparse reference material keeps what fits', fits, r.best(100000));
    ok('and is not given up on', fits > 0);
}

// 4. Messages of very different sizes, the big ones last.
{
    const sizes = [...even(30), 40000, 40000, 40000];
    const r = request({ fixed: 2000, sizes, perChar: 0.25 });
    const fits = await cutToFit({ ...r, available: 12000 });
    ok('uneven messages: the result fits', r.real(fits) <= 12000, `kept ${fits}`);
    ok('uneven messages: and is not far short of the most that fits', r.best(12000) - fits <= 1, `kept ${fits} of ${r.best(12000)}`);
}

// 5. Later messages denser than earlier ones, so the estimate runs short and has
//    to be corrected — by measuring again, never by sending something too big.
{
    const sizes = even(100);
    const fixed = 1000;
    const real = count => fixed + sizes.slice(0, count).reduce((sum, size, i) => sum + size * (i < 20 ? 1 : 0.1), 0);
    const asked = [];
    const fits = await cutToFit({ sizes, fixed, used: real(100), available: 15000, measure: async count => { asked.push(count); return real(count); } });
    ok('an estimate that runs short is corrected', real(fits) <= 15000, `kept ${fits}, ${real(fits)} tokens`);
    ok('in a handful of measurements', asked.length <= 8, `${asked.length} measurements`);
    ok('each of fewer messages than the last', asked.every((count, i) => i === 0 || count < asked[i - 1]), asked.join(','));
}

// 6. Only the first message fits, and it is found rather than estimated away.
{
    const r = request({ fixed: 9000, sizes: [500, 4000, 4000], perChar: 1 });
    check('the first message alone is kept when it is all that fits', await cutToFit({ ...r, available: 9600 }), 1);
    ok('having been measured', r.asked.includes(1));
}

// 7. Not even the first fits: 0, which the rebuild reports as an overflow.
{
    const r = request({ fixed: 9000, sizes: [5000, 4000], perChar: 1 });
    check('nothing is kept when the first message does not fit', await cutToFit({ ...r, available: 9600 }), 0);
}

// 8. The fixed part alone is over: 0, with no measuring at all.
{
    const r = request({ fixed: 12000, sizes: even(10), perChar: 0.25 });
    check('nothing fits on top of a fixed part that is itself too big', await cutToFit({ ...r, available: 10000 }), 0);
    check('and nothing is measured to find that out', r.asked, []);
}

// 9. Degenerate inputs end rather than spin.
check('no messages', await cutToFit({ sizes: [], used: 500, fixed: 100, available: 200, measure: async () => 500 }), 0);
check('messages with no length', await cutToFit({ sizes: [0, 0, 0], used: 500, fixed: 100, available: 200, measure: async () => 500 }), 0);
check('a tokenizer that reports less than the fixed part', await cutToFit({ sizes: even(4), used: 500, fixed: 900, available: 950, measure: async count => count * 100 }), 4);

// 10. The estimator: four characters a token until it has seen a count, then
//     whatever that tokenizer has actually come to.
{
    const estimator = createEstimator();
    const text = 'x'.repeat(4000);
    check('before any count, about four characters a token', estimator.estimate('a', text), 1000);
    check('nothing is nothing', estimator.estimate('a', ''), 0);
    check('something is at least one', estimator.estimate('a', 'x'), 1);

    estimator.learn('a', 'y'.repeat(1000), 1000);
    check('after a count, that tokenizer\'s own rate', estimator.estimate('a', text), 4000);
    check('which another tokenizer does not inherit', estimator.estimate('b', text), 1000);

    estimator.learn('a', 'y'.repeat(3000), 1000);
    check('rates are pooled over everything counted', estimator.estimate('a', text), 2000);

    estimator.learn('c', 'short', 5);
    check('a text too short to say anything is not learned from', estimator.estimate('c', text), 1000);
    estimator.learn('c', 'y'.repeat(1000), 0);
    check('nor is a count of nothing', estimator.estimate('c', text), 1000);
}

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log(`All ${checks} batch-cutting and live-size checks pass.`);
