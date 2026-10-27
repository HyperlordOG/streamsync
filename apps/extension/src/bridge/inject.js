/**
 * StreamSync - Main World Bridge Entrypoint
 * Executed directly in the web page's MAIN execution world via Manifest V3 "world": "MAIN".
 * Has direct access to window.netflix, window.Hls, and page globals without CSP inline script restrictions.
 */

import { installMainWorldBridge } from '@streamsync/injectors';

installMainWorldBridge();
