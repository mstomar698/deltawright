import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export const fixtureUrl = (name: string) => pathToFileURL(resolve(here, 'fixtures', name)).href;

/** file:// URL of the controlled north-star fixture. */
export const FIXTURE_URL = fixtureUrl('northstar.html');

/** file:// URL of the live-ticking-page settle fixture. */
export const LIVE_FIXTURE_URL = fixtureUrl('livepage.html');

/** file:// URL of the GWT-faithful legacy fixture (deferred commands, glass, reposition). */
export const GWT_FIXTURE_URL = fixtureUrl('gwt.html');

/** file:// URL of the pageMap fixture (poor-a11y div-soup + overlay occlusion of look-alikes). */
export const PAGEMAP_FIXTURE_URL = fixtureUrl('pagemap.html');

/** file:// URL of the effect-settle fixture (client re-render, background ticker, canvas, no-op). */
export const EFFECT_SETTLE_FIXTURE_URL = fixtureUrl('effect-settle.html');

/** file:// URL of the scoreSelectors fixture (durable / unstable-id / ambiguous / text-volatile / geom). */
export const SCORE_SELECTORS_FIXTURE_URL = fixtureUrl('score-selectors.html');

/** file:// URL of the north-star authoring fixture (RPC-style delayed poor-a11y panel + occlusion). */
export const NORTHSTAR_AUTHORING_FIXTURE_URL = fixtureUrl('northstar-authoring.html');

/** file:// URL of the retention fixture (re-render → retained / moved / ambiguous / lost selectors). */
export const RETENTION_FIXTURE_URL = fixtureUrl('retention.html');
