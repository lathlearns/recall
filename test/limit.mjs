/**
 * Recall — the concurrency cap.
 *
 * The cap exists so that opening the manager queues its token counts instead of
 * firing one request per summary row at once. What makes it worth a test is the
 * handoff when a task finishes: decrementing the counter and *then* waking a
 * waiter leaves the slot momentarily free, so a caller arriving in that window
 * takes it without queueing — the cap is exceeded, and a waiter sits behind a
 * queue that has already drained. Both symptoms are load-dependent and neither
 * shows up in casual use.
 *
 * Run:  node test/limit.mjs
 */

import { createLimiter } from '../src/limit.js';

const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

/** A task that resolves only when told to, so overlap is observable. */
function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

// 1. Never more than the cap at once, and everything still finishes.
{
    const limit = createLimiter(3);
    let running = 0;
    let peak = 0;

    const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) => limit(async () => {
            running++;
            peak = Math.max(peak, running);
            await tick();
            running--;
            return i;
        })),
    );

    check('every task ran', results.length, 20);
    check('results come back from their own task', results.slice(0, 4), [0, 1, 2, 3]);
    check('concurrency never exceeded the cap', peak <= 3, true);
    check('the pool drained', running, 0);
}

// 2. A finishing task hands its slot straight to a waiter. With the cap full and
//    one task released, exactly one more may start — not zero (a lost wake-up)
//    and not two (a slot double-counted).
{
    const limit = createLimiter(2);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    for (const gate of gates) {
        void limit(async () => { started++; await gate.promise; });
    }

    await tick();
    check('only the cap starts immediately', started, 2);

    gates[0].resolve();
    await tick();
    check('releasing one admits exactly one more', started, 3);
}

// 2b. The race the handoff exists to prevent, which 2 alone does not catch.
//
//     Decrementing the counter and then waking a waiter passes every test where
//     all the callers arrive at once, because completions and wake-ups alternate
//     and the pattern happens to hold. It breaks when a *new* caller arrives
//     after a waiter has been woken: the counter says a slot is free when the
//     woken task is already using it, so the newcomer starts too and the cap is
//     exceeded. That is exactly the manager's shape — a burst of row counts,
//     then more counts as panes open.
{
    const limit = createLimiter(2);
    const gates = [deferred(), deferred(), deferred(), deferred()];
    let running = 0;
    let peak = 0;

    const start = gate => limit(async () => {
        running++;
        peak = Math.max(peak, running);
        await gate.promise;
        running--;
    });

    for (const gate of gates) {
        void start(gate);
    }
    await tick();

    // Free one slot, which a waiter immediately takes.
    gates[0].resolve();
    await tick();

    // The newcomer must queue behind it, not slip into a slot that only looks free.
    const late = deferred();
    void start(late);
    await tick();

    check('a late caller cannot exceed the cap', peak <= 2, true);

    for (const gate of [...gates.slice(1), late]) {
        gate.resolve();
    }
    await tick();
}

// 3. A task that throws must release its slot. Without a finally, one failure
//    shrinks the pool permanently and enough of them stop counting entirely.
{
    const limit = createLimiter(1);

    await limit(async () => { throw new Error('boom'); }).catch(() => {});
    await limit(async () => { throw new Error('boom'); }).catch(() => {});

    let ran = false;
    await limit(async () => { ran = true; });

    check('the pool survives failing tasks', ran, true);
}

// 4. The rejection still reaches the caller — releasing the slot must not
//    swallow it into a success.
{
    const limit = createLimiter(2);
    let message = null;
    await limit(async () => { throw new Error('propagated'); }).catch(e => { message = e.message; });
    check('a task failure reaches the caller', message, 'propagated');
}

// 5. A nonsense cap degrades to serial rather than to zero, which would hang.
for (const bad of [0, -1, NaN, undefined]) {
    const limit = createLimiter(bad);
    let ran = 0;
    await Promise.all([limit(async () => { ran++; }), limit(async () => { ran++; })]);
    check(`a cap of ${String(bad)} still runs its tasks`, ran, 2);
}

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All 13 concurrency-cap checks pass.');
