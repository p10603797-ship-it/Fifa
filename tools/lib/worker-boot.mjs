/**
 * [FND-06] Worker thread bootstrap: worker threads do not inherit tsx's loader hooks from `tsx tools/soak.ts`,
 * so register tsx here (TypeScript + extensionless imports) and then load the TypeScript worker.
 */
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
