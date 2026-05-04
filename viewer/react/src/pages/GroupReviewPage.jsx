import template from '../templates/group-review-body.html?raw';
import { useLegacyScripts } from '../lib/useLegacyScripts';

const scripts = [
  'https://unpkg.com/openseadragon@4.1.1/build/openseadragon/openseadragon.min.js',
  './zoomify.js',
  './photo-meta.js',
  './grouping.js',
  './media-filter.js',
  './session-verify.js',
  './group-review.js',
];

export default function GroupReviewPage() {
  useLegacyScripts(scripts);
  return <div dangerouslySetInnerHTML={{ __html: template }} />;
}
