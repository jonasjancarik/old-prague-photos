import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export function installLeaflet() {
  window.L = L;
}

export async function installMarkerCluster() {
  installLeaflet();
  await import('leaflet.markercluster');
}
