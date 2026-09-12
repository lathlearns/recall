/**
 * Recall — a concurrency cap.
 *
 * Free of SillyTavern imports so it can be tested, for the same reason stream.js
 * is: the handoff between a finishing task and a waiting one is the kind of logic
 * that works for every case you try by hand and deadlocks on the one you did not.
 *
 * The subtlety is in what happens when a task finishes. Decrementing the counter
 * and then waking a waiter is wrong — between those two steps the slot is free,
 * and a caller arriving in that window takes it without queueing, so the cap can
 * be exceeded and a waiter can be left waiting behind a queue that has already
 * drained. The slot is therefore handed *directly* to the next waiter and the
 * counter is only decremented when nobody is waiting for it.
 */

/**
 * @param {number} max Most tasks allowed to run at once.
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(max) {
    const ceiling = Math.max(1, Number(max) || 1);

    let active = 0;
    /** @type {(() => void)[]} */
    const waiting = [];

    return async function run(task) {
        if (active < ceiling) {
            active++;
        } else {
            await new Promise(resolve => waiting.push(resolve));
        }

        try {
            return await task();
        } finally {
            // In a finally, so a task that throws releases its slot. Without it one
            // failure permanently shrinks the pool and enough of them stop every
            // count in the session.
            const next = waiting.shift();
            if (next) {
                next();
            } else {
                active--;
            }
        }
    };
}
