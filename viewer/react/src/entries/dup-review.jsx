import '../../../static/styles.css';
import template from '../templates/dup-review-body.html?raw';
import { mountPage } from '../lib/loadLegacyScripts.js';

mountPage(template, [
  'https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js',
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './dup-review.js',
  './mode-picker.js',
]).catch(console.error);
