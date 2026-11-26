import {initializeFabric} from './gateway.mjs';

try {
  console.log(JSON.stringify(await initializeFabric(), null, 2));
} catch (error) {
  console.error(error.reason || error.message, error.pendingTransactionId || '');
  process.exitCode = 1;
}
