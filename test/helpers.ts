import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** file:// URL of the controlled north-star fixture. */
export const FIXTURE_URL = pathToFileURL(resolve(here, 'fixtures/northstar.html')).href;
