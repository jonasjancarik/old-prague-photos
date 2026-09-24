import '../../../static/styles.css';
import template from '../templates/pomoc-body.html?raw';
import { installLeaflet } from '../lib/leaflet.js';
import { mountPage } from '../lib/loadLegacyScripts.js';
import { installOpenSeadragon } from '../lib/openseadragon.js';

installLeaflet();
installOpenSeadragon();
mountPage(template, [
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './candidate-client.js',
  './media-filter.js',
  './session-verify.js',
  './own-proposals.js',
  './correction-ui.js',
  './pomoc.js',
  './mode-picker.js',
]).catch(console.error);
