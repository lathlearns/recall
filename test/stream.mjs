/**
 * Recall — draining a streamed response.
 *
 * `consumeStream` is the one piece of the streaming path whose logic can be wrong
 * without anything failing. ST yields *cumulative* chunks, and the natural thing
 * to write for a stream — append each chunk — produces a summary containing every
 * prefix of itself, which reads as a model stuck in a loop rather than as a bug in
 * the reader. So the cumulative contract is pinned here rather than trusted.
 *
 * Run:  node test/stream.mjs
 */

import { consumeStream } from '../src/stream.js';

const failures = [];

function check(label, actual, expected) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        failures.push(`${label}: expected ${b}, got ${a}`);
    }
}

/** A factory over fixed chunks, in ST's shape. */
function streamOf(...chunks) {
    return async function* () {
        for (const chunk of chunks) {
            yield chunk;
        }
    };
}

// 1. The whole point: cumulative chunks are assigned, not concatenated.
{
    const result = await consumeStream(streamOf(
        { text: 'The party' },
        { text: 'The party reached' },
        { text: 'The party reached the pass.' },
    ));

    check('cumulative content', result.content, 'The party reached the pass.');
    check('chunk count', result.chunks, 3);
}

// 2. Reasoning accumulates on its own axis, and never leaks into the content.
{
    const result = await consumeStream(streamOf(
        { text: '', state: { reasoning: 'Who is present' } },
        { text: 'They', state: { reasoning: 'Who is present, and when' } },
        { text: 'They left.', state: { reasoning: 'Who is present, and when' } },
    ));

    check('streamed content', result.content, 'They left.');
    check('streamed reasoning', result.reasoning, 'Who is present, and when');
}

// 3. Progress is reported once per chunk, with the running totals.
{
    const seen = [];
    await consumeStream(
        streamOf({ text: 'a' }, { text: 'ab' }, { text: 'abc' }),
        progress => seen.push(progress.content),
    );

    check('progress per chunk', seen, ['a', 'ab', 'abc']);
}

// 4. A chunk missing `text` leaves what we already have alone. A provider that
//    sends a keepalive or a usage-only frame must not blank the summary.
{
    const result = await consumeStream(streamOf(
        { text: 'kept' },
        { state: { reasoning: 'still thinking' } },
        {},
    ));

    check('content survives a textless chunk', result.content, 'kept');
    check('reasoning survives too', result.reasoning, 'still thinking');
}

// 5. An empty string is a real value, not a missing one: a provider that resets
//    the text must be able to say so.
{
    const result = await consumeStream(streamOf({ text: 'oops' }, { text: '' }));
    check('empty string is honoured', result.content, '');
}

// 6. A failing progress display must not abandon a request already paid for.
{
    const original = console.error;
    console.error = () => {};

    let finished = null;
    try {
        finished = await consumeStream(
            streamOf({ text: 'a' }, { text: 'ab' }),
            () => { throw new Error('render blew up'); },
        );
    } catch (error) {
        failures.push(`a throwing progress handler aborted the stream: ${error.message}`);
    } finally {
        console.error = original;
    }

    if (finished) {
        check('stream completed despite a failing handler', finished.content, 'ab');
    }
}

// 7. An error mid-stream propagates. Half a summary is not a summary, and the
//    caller has to be able to tell that it never finished.
{
    const exploding = async function* () {
        yield { text: 'half' };
        throw new Error('connection lost');
    };

    let message = null;
    try {
        await consumeStream(exploding);
    } catch (error) {
        message = error.message;
    }

    check('mid-stream failure propagates', message, 'connection lost');
}

// 8. A non-streaming response reaching here is a programming error, not an empty
//    summary — ST hands back a factory, and anything else means the branch that
//    decides whether to stream and the branch that reads it have disagreed.
{
    let message = null;
    try {
        await consumeStream({ content: 'not a factory' });
    } catch (error) {
        message = error.message;
    }

    check('a non-factory is refused', message, 'The connection returned no stream to read.');
}

if (failures.length) { console.log('FAIL:'); failures.forEach(f => console.log('  -', f)); process.exit(1); }
console.log('All 8 stream-draining checks pass.');
