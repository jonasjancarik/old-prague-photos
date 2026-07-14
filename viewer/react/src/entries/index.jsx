import '../../../static/styles.css';
import template from '../templates/index-body.html?raw';
import { mountPage } from '../lib/loadLegacyScripts.js';

mountPage(template, [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js',
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './correction-ui.js',
  './app.js',
]).catch(console.error);
