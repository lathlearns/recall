/**
 * Recall — template safety tests.
 *
 * Extension templates are compiled by Handlebars, and ST registers a global
 * catch-all that pipes every unknown expression through `substituteParams`:
 *
 *     Handlebars.registerHelper('helperMissing', function () {
 *         return substituteParams(`{{${options.name}}}`);
 *     });
 *
 * So a macro name written as prose in help text does not stay prose — it is
 * resolved at render time. Naming the recall macro in a paragraph expanded it to
 * the entire active summary, twice, in the middle of a settings panel. Handlebars
 * does not respect HTML comments either, so a malformed example inside one is a
 * compile error that takes the whole template with it.
 *
 * Run:  node test/templates.mjs
 */

import Handlebars from 'handlebars';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATES = ['templates/manager.html', 'templates/drawer.html'];

const failures = [];

// Mirror ST's catch-all so anything it would expand is visible here.
const expanded = [];
Handlebars.registerHelper('helperMissing', function () {
    const options = arguments[arguments.length - 1];
    expanded.push(options.name);
    return `<<<EXPANDED:${options.name}>>>`;
});

for (const file of TEMPLATES) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    expanded.length = 0;

    let rendered;
    try {
        rendered = Handlebars.compile(source)({});
    } catch (error) {
        failures.push(`${file}: Handlebars compile error — ${error.message}`);
        continue;
    }

    if (expanded.length) {
        failures.push(`${file}: ST would expand ${expanded.map(n => `{{${n}}}`).join(', ')} at render time. `
            + 'Write the braces as &#123; and &#125;.');
    }
    if (rendered.includes('<<<EXPANDED:')) {
        failures.push(`${file}: expanded output leaked into the rendered template`);
    }
}

if (failures.length) {
    console.log('FAIL:');
    failures.forEach(f => console.log('  -', f));
    process.exit(1);
}
console.log(`Templates compile with no macro expansion (${TEMPLATES.length} files).`);
