// Start the Mugibot server:  npm start
import { quietExperimentalWarnings, requireNode } from './runtime.js';

requireNode();
quietExperimentalWarnings();
await import('./main.js');
