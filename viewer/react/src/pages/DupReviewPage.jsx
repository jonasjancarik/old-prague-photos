import template from '../templates/dup-review-body.html?raw';
import { useLegacyScripts } from '../lib/useLegacyScripts';

const scripts = [
  'https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js',
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './dup-review.js',
  './mode-picker.js',
];

export default function DupReviewPage() {
  useLegacyScripts(scripts);
  return <div dangerouslySetInnerHTML={{ __html: template }} />;
}
