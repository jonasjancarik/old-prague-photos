import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

// Leaflet derives default marker image paths from its stylesheet at runtime,
// which breaks once Vite fingerprints the assets. Point it at the bundled URLs.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({ iconRetinaUrl, iconUrl, shadowUrl });

export function installLeaflet() {
  window.L = L;
}

export async function installMarkerCluster() {
  installLeaflet();
  await import('leaflet.markercluster');
}
