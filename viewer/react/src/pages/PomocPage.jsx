import template from '../templates/pomoc-body.html?raw';
import { useLegacyScripts } from '../lib/useLegacyScripts';

const scripts = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js',
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './correction-ui.js',
  './pomoc.js',
  './mode-picker.js',
];

export default function PomocPage() {
  useLegacyScripts(scripts);
  return <div dangerouslySetInnerHTML={{ __html: template }} />;
}
