import '../../../static/styles.css';
import template from '../templates/admin-body.html?raw';
import { mountPage } from '../lib/loadLegacyScripts.js';

mountPage(template, ['./annotation-admin.js', './admin.js']).catch(console.error);
