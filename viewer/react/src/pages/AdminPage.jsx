import template from '../templates/admin-body.html?raw';
import { useLegacyScripts } from '../lib/useLegacyScripts';

const scripts = ['./admin.js'];

export default function AdminPage() {
  useLegacyScripts(scripts);
  return <div dangerouslySetInnerHTML={{ __html: template }} />;
}
