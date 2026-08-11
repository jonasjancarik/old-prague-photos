import '../../../static/styles.css';
import template from '../templates/group-review-body.html?raw';
import { mountPage } from '../lib/loadLegacyScripts.js';
import { installOpenSeadragon } from '../lib/openseadragon.js';

installOpenSeadragon();
mountPage(template, [
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './group-review.js',
]).catch(console.error);
