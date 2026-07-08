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
