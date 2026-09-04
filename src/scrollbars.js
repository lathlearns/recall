/**
 * Recall — how much room the panes have to leave for a scrollbar.
 *
 * There are two kinds of scrollbar and they need opposite things from a layout.
 *
 * A *classic* bar is part of the box: the browser takes its width out of the
 * content area, so content never ends up underneath one and a pane only needs a
 * few pixels of breathing room next to it. `scrollbar-gutter: stable` reserves
 * that width whether or not a bar is currently showing, so a pane does not
 * reflow the moment its content grows past the fold.
 *
 * An *overlay* bar — Firefox's default on a Windows 11 that auto-hides
 * scrollbars, and the norm on macOS — has zero width and floats above the
 * content instead. `scrollbar-gutter` is specified to do nothing for these, and
 * correctly so: there is no width to reserve. Nothing about the box changes, so
 * the pane's right-hand column of token counts and action buttons sits directly
 * under the bar. It reads as merely tight while the bar is in its resting state,
 * and becomes an actual occlusion when a hover fattens it.
 *
 * No CSS query distinguishes the two, so this measures: give an element a
 * scrollbar and see whether it cost anything. Zero means overlay, and the panes
 * take their gutter as padding instead, wide enough for a hovered bar.
 */

/**
 * Room to leave beside an overlay bar. Firefox on Windows draws a resting bar of
 * roughly 10px that expands to about 17px under the pointer, so this clears the
 * hovered width with a few pixels to spare. It is in `em` deliberately: ST scales
 * its whole UI with the user's font size, and a gutter fixed in pixels would look
 * mean at a large one and wasteful at a small one.
 */
const OVERLAY_GUTTER = '1.5em';

/**
 * Room to leave beside a classic bar, which has already taken its own width out
 * of the box. Purely the gap between the content and the bar.
 */
const CLASSIC_GUTTER = '0.6em';

/**
 * Measures whether this browser's scrollbars occupy layout width.
 *
 * The probe is forced to `overflow-y: scroll` rather than `auto` so a bar is
 * present to measure without having to give the element overflowing content, and
 * it is given a size because a zero-width element reports a zero-width scrollbar
 * everywhere. `scrollbar-width` is pinned to `auto` so that a theme which has
 * hidden scrollbars for its own elements cannot make every platform look like an
 * overlay one.
 *
 * @returns {boolean} true when scrollbars float above the content.
 */
export function usesOverlayScrollbars() {
    const probe = document.createElement('div');
    probe.style.cssText = [
        'position: absolute',
        'top: -9999px',
        'left: -9999px',
        'width: 100px',
        'height: 100px',
        'overflow-y: scroll',
        'scrollbar-width: auto',
    ].join(';');

    document.body.appendChild(probe);
    const width = probe.offsetWidth - probe.clientWidth;
    probe.remove();

    return width === 0;
}

/**
 * Publishes the gutter as custom properties on the document root, where the
 * stylesheet picks them up for every pane that scrolls.
 *
 * `--recall-scroll-stable` turns `scrollbar-gutter` off on overlay platforms.
 * It should already be inert there — the property is specified not to apply to
 * overlay scrollbars — but a browser that reserved the width anyway would add it
 * on top of a gutter that has already been sized to cover the bar by hand, and
 * the pane would carry two gutters' worth of dead space. Saying which one is
 * wanted costs nothing and does not depend on being right about the other.
 *
 * Run once at startup. The kind of scrollbar a browser draws is a platform
 * decision that does not change while a page is open — the OS setting behind it
 * needs a browser restart to take effect — so there is nothing to keep in sync
 * afterwards.
 *
 * @param {boolean} [overlay] Whether scrollbars float above the content.
 *     Defaults to measuring; the parameter exists so the mapping can be tested
 *     on a platform that is not the one being described.
 */
export function applyScrollbarGutter(overlay = usesOverlayScrollbars()) {
    const root = document.documentElement.style;
    root.setProperty('--recall-scroll-gutter', overlay ? OVERLAY_GUTTER : CLASSIC_GUTTER);
    root.setProperty('--recall-scroll-stable', overlay ? 'auto' : 'stable');
}
