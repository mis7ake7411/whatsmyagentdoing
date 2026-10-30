// Focused native/client UI checks using the same synthetic fixtures as test:ui.
process.env.WMAD_UI_CLIENTS_ONLY = '1';
require('./ui.cjs');
