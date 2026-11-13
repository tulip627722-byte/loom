import { createPaths } from './paths.ts';
import { RuntimeStore } from './store.ts';
import { MemoryService } from './memory.ts';
import { migrateLegacy } from './migrate.ts';

const paths = createPaths();
const store = new RuntimeStore(paths.data);
const memory = new MemoryService(store, paths.data, paths.backups);
try {
  const result = migrateLegacy(paths, store, memory, process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  store.close();
}
