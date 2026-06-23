// Local / VPS entry point — starts a long-running HTTP server.
// (On Vercel the app is imported by api/index.js instead; no listen there.)
import app from './app.js';
import { backend } from './store.js';

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

app.listen(PORT, () => {
  console.log(`Smart QR Manager running at ${BASE_URL}  (storage: ${backend})`);
});
