import '../../../static/styles.css';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import template from '../templates/index-body.html?raw';
import { installLeaflet, installMarkerCluster } from '../lib/leaflet.js';
import { mountPage } from '../lib/loadLegacyScripts.js';
import { installOpenSeadragon } from '../lib/openseadragon.js';

async function bootstrap() {
  installLeaflet();
  installOpenSeadragon();
  await installMarkerCluster();
  await mountPage(template, [
    './zoomify.js',
    './photo-meta.js',
    './grouping.js',
    './media-filter.js',
    './session-verify.js',
    './own-proposals.js',
    './correction-ui.js',
    './feedback-ui.js',
    './search-ui.js',
    `./app.js?v=${__MAP_APP_SCRIPT_VERSION__}`,
  ]);
}

bootstrap().catch(console.error);
